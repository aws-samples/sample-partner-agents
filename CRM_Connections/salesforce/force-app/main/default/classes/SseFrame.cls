/**
 * Feature: partner-central-chat-agent
 *
 * Server-Sent Events (SSE) frame value class.
 *
 * Represents a single SSE frame with the four standard fields (`event`, `data`,
 * `id`, `retry`) and emits them in the canonical wire format defined by the
 * SSE specification (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 *
 * Public fields are used so `JSON.serialize` / `JSON.deserialize` can round-trip
 * instances for audit logging and platform-event payloads. Structural equality
 * is implemented so property-based round-trip tests can verify parse/emit
 * correctness without relying on reference equality.
 *
 * See requirements 4.2, 4.3.
 */
public with sharing class SseFrame {

    // Public instance fields (JSON.serialize / JSON.deserialize target these directly).
    public String event;
    public String data;
    public String id;
    public Integer retry;

    /** No-arg constructor required by `JSON.deserialize`. */
    public SseFrame() {}

    /** Full-args constructor. */
    public SseFrame(String event, String data, String id, Integer retry) {
        this.event = event;
        this.data = data;
        this.id = id;
        this.retry = retry;
    }

    /**
     * Returns true when this frame signals stream termination. The design doc
     * names `done` as the canonical terminal event; `complete` and `end` are
     * accepted as common synonyms so the parser is tolerant of upstream
     * variations.
     */
    public Boolean isTerminal() {
        return 'done'.equals(this.event)
            || 'complete'.equals(this.event)
            || 'end'.equals(this.event);
    }

    /**
     * Emits the canonical SSE wire string for the given frame.
     *
     * Field order is deterministic (`id`, `event`, `retry`, `data`) to make
     * round-trip property tests simpler; the SSE spec does not mandate an
     * order and compliant parsers tolerate any ordering. Null fields are
     * omitted entirely. Multi-line `data` values are emitted as multiple
     * `data:` lines per the SSE spec. The frame is terminated by a blank
     * line (`\n\n`).
     */
    public static String emit(SseFrame frame) {
        if (frame == null) { return ''; }
        String out = '';
        if (frame.id != null) {
            out += 'id: ' + frame.id + '\n';
        }
        if (frame.event != null) {
            out += 'event: ' + frame.event + '\n';
        }
        if (frame.retry != null) {
            out += 'retry: ' + String.valueOf(frame.retry) + '\n';
        }
        if (frame.data != null) {
            if (frame.data == '') {
                // Preserve "empty data" distinct from "no data" on the wire.
                out += 'data: \n';
            } else {
                // SSE spec: split multi-line data on \n and emit one line per chunk.
                List<String> lines = frame.data.split('\n', -1);
                for (String line : lines) {
                    out += 'data: ' + line + '\n';
                }
            }
        }
        // Frame terminator: blank line.
        out += '\n';
        return out;
    }

    /**
     * Structural equality. Null-safe per-field comparison so property-based
     * round-trip tests can compare parsed-and-reserialized frames to originals.
     */
    public Boolean equals(Object obj) {
        if (obj == null) { return false; }
        if (!(obj instanceof SseFrame)) { return false; }
        SseFrame other = (SseFrame) obj;
        return stringsEqual(this.event, other.event)
            && stringsEqual(this.data, other.data)
            && stringsEqual(this.id, other.id)
            && integersEqual(this.retry, other.retry);
    }

    /** Hash derived from the same fields used by `equals`, so the contract holds. */
    public Integer hashCode() {
        String composite =
            String.valueOf(this.event) + '|' +
            String.valueOf(this.data) + '|' +
            String.valueOf(this.id) + '|' +
            String.valueOf(this.retry);
        return composite.hashCode();
    }

    /** Null-safe String comparison used internally by `equals`. */
    private static Boolean stringsEqual(String a, String b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a.equals(b);
    }

    /** Null-safe Integer comparison used internally by `equals`. */
    private static Boolean integersEqual(Integer a, Integer b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a == b;
    }
}
