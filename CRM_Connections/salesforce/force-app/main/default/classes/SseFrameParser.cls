/**
 * Feature: partner-central-chat-agent
 *
 * Pure-Apex parser for buffered Server-Sent Events (SSE) bodies. Companion to
 * `SseFrame.emit(...)`; together they provide the round-trip property required
 * by Req 4.3 and support the Stream_Handler's incremental rendering behavior
 * (Req 4.1, 4.2, 4.4).
 *
 * This class operates on an already-buffered body String rather than on a
 * chunked stream, because Apex `HttpResponse` exposes the SSE body as a single
 * buffered payload once the callout completes. Truncation detection (Req 4.5)
 * is deliberately left to the caller: `parse` preserves a trailing partial
 * frame verbatim so the `McpClient` can tell whether the last frame was
 * terminal.
 *
 * Parsing follows the HTML Living Standard rules for `text/event-stream`:
 *   - Lines end with `\r\n`, `\r`, or `\n` (all three are normalized to `\n`).
 *   - A blank line terminates a frame.
 *   - `field:value` and `field: value` both set the field to `value`; only one
 *     leading space after the colon is consumed (so `field:  value` parses as
 *     ` value`).
 *   - Lines beginning with `:` are comments and ignored.
 *   - Known fields are `event`, `data`, `id`, `retry`; unknown fields are
 *     ignored.
 *   - Multiple `data:` lines in one frame are joined with `\n`.
 *   - Multiple `event:` or `id:` lines — last occurrence wins.
 *   - `retry:` must be a non-negative integer or the field is ignored.
 *
 * See requirements 4.1, 4.2, 4.4.
 */
public with sharing class SseFrameParser {

    /** Frame delimiter per the SSE spec: a single blank line. */
    private static final String FRAME_DELIMITER = '\n\n';

    /** Byte-order-mark that may prefix the very first line of an SSE stream. */
    private static final String BOM = '\uFEFF';

    /**
     * Private constructor — this class exposes only static methods and holds
     * no instance state.
     */
    private SseFrameParser() {}

    /**
     * Parses a buffered SSE body string into an ordered list of `SseFrame`s.
     *
     * Empty or null input returns an empty list. The body is normalized to
     * LF line endings and split on `\n\n`; each non-empty frame is then
     * processed field-by-field. Pure-whitespace frames (where every field is
     * null/empty after parsing) are dropped so trailing `\n\n\n...` does not
     * produce spurious empty frames.
     *
     * A trailing partial frame (body not terminated by `\n\n`) is preserved
     * as the final element of the returned list, so the caller can detect
     * stream truncation by inspecting whether the last frame is terminal
     * (Req 4.5). Partial frames are otherwise parsed identically to complete
     * ones.
     *
     * @param body the buffered SSE body; may be null or empty
     * @return zero-or-more frames in document order
     */
    public static List<SseFrame> parse(String body) {
        List<SseFrame> frames = new List<SseFrame>();
        if (String.isEmpty(body)) {
            return frames;
        }

        // Normalize all line-ending variants the SSE spec permits to `\n`.
        // Apex `String.replace` is a literal replace (not regex), which is
        // exactly what we want here.
        String normalized = body.replace('\r\n', '\n').replace('\r', '\n');

        // `-1` limit preserves trailing empty strings so we don't silently
        // drop the final frame of a properly-terminated body. We subsequently
        // filter empty strings so the result is not affected by the choice.
        List<String> rawFrames = normalized.split('\\n\\n', -1);

        for (String rawFrame : rawFrames) {
            if (String.isEmpty(rawFrame)) {
                // Empty string between two `\n\n` sequences — no content to
                // parse; skip.
                continue;
            }
            SseFrame parsed = parseFrame(rawFrame);
            if (parsed != null) {
                frames.add(parsed);
            }
        }
        return frames;
    }

    /**
     * Thin wrapper around `SseFrame.isTerminal()` that keeps terminal-event
     * detection colocated with the parser. Symmetric with the caller pattern
     * used by `McpClient` (parser decides "is this the last frame", client
     * decides "what to do about it"). Null-safe.
     *
     * @param frame the frame to inspect; may be null
     * @return `true` iff the frame's event name marks stream completion
     */
    public static Boolean isTerminalFrame(SseFrame frame) {
        if (frame == null) {
            return false;
        }
        return frame.isTerminal();
    }

    // ---- Internal helpers ---------------------------------------------------

    /**
     * Parses a single SSE frame body (the text between two `\n\n`
     * delimiters) into an `SseFrame`. Returns null for frames whose every
     * field is absent after parsing (for example, a frame consisting
     * exclusively of comments or blank lines), so `parse` can filter them.
     */
    private static SseFrame parseFrame(String rawFrame) {
        List<String> lines = rawFrame.split('\n', -1);

        String eventName = null;
        List<String> dataLines = new List<String>();
        String idValue = null;
        Integer retryValue = null;

        for (Integer i = 0; i < lines.size(); i++) {
            String line = lines[i];

            // The BOM may legitimately prefix the very first line of a stream.
            // Strip it unconditionally; per spec it carries no semantics.
            if (i == 0 && line.startsWith(BOM)) {
                line = line.substring(BOM.length());
            }

            // A line that is empty or pure whitespace contributes no field
            // and is not a comment either; ignore it. (The SSE spec treats a
            // blank line as a frame delimiter, but delimiters have already
            // been consumed by the split above — any blanks seen here are
            // incidental whitespace the producer left in the frame body.)
            if (line.length() == 0) {
                continue;
            }

            // Comment: line starts with `:`. Per spec, discard.
            if (line.startsWith(':')) {
                continue;
            }

            Integer colonIdx = line.indexOf(':');
            String field;
            String value;
            if (colonIdx < 0) {
                // Spec: a line with no colon is treated as a field name with
                // an empty value. We still only recognize our four known
                // fields, so an unnamed line like `data` (no colon, no value)
                // sets `data` to empty string; anything else is ignored.
                field = line;
                value = '';
            } else {
                field = line.substring(0, colonIdx);
                value = line.substring(colonIdx + 1);
                // Per spec: strip a single leading space after the colon, if
                // present. `field: value` and `field:value` both yield
                // `value`; `field:  value` yields ` value`.
                if (value.startsWith(' ')) {
                    value = value.substring(1);
                }
            }

            // Field-name match MUST be case-sensitive per the SSE spec, so
            // we use `.equals` rather than Apex's `==` (which is
            // case-insensitive for String operands).
            if ('event'.equals(field)) {
                // Last `event:` line in a frame wins.
                eventName = value;
            } else if ('data'.equals(field)) {
                // Multiple `data:` lines are joined with `\n`.
                dataLines.add(value);
            } else if ('id'.equals(field)) {
                // Last `id:` line in a frame wins. The spec says ids
                // containing NUL should be ignored; we treat NUL-bearing ids
                // as any other string here because Apex doesn't surface NUL
                // handling specially and the MCP schema forbids NUL in ids.
                idValue = value;
            } else if ('retry'.equals(field)) {
                Integer parsed = tryParseNonNegativeInt(value);
                if (parsed != null) {
                    retryValue = parsed;
                }
                // Per spec: malformed retry values are ignored silently.
            }
            // Unknown fields: ignored per spec.
        }

        String dataValue = dataLines.isEmpty() ? null : String.join(dataLines, '\n');

        // Drop frames where nothing was set — callers don't need to see
        // comment-only or whitespace-only frames.
        if (eventName == null && dataValue == null && idValue == null && retryValue == null) {
            return null;
        }

        return new SseFrame(eventName, dataValue, idValue, retryValue);
    }

    /**
     * Parses a `retry:` field value as a non-negative decimal integer. Per
     * the SSE spec, any non-conforming value (negative, leading sign,
     * non-digit characters, overflow) causes the field to be ignored — this
     * helper signals that by returning null.
     */
    private static Integer tryParseNonNegativeInt(String s) {
        if (String.isBlank(s)) {
            return null;
        }
        // The spec restricts retry to base-10 ASCII digits only. Reject any
        // input containing a sign or non-digit so we don't accidentally
        // accept values `Integer.valueOf` would otherwise tolerate.
        for (Integer i = 0; i < s.length(); i++) {
            Integer codeUnit = s.charAt(i);
            if (codeUnit < 48 /* '0' */ || codeUnit > 57 /* '9' */) {
                return null;
            }
        }
        try {
            return Integer.valueOf(s);
        } catch (System.TypeException e) {
            // Overflow or similar — treat as malformed per spec.
            return null;
        }
    }
}
