/**
 * Feature: partner-central-chat-agent
 *
 * Pure classifier for MCP-announced pending operations. Implements the
 * fail-safe default from Req 6.9: if the upstream response does not
 * unambiguously identify an operation as read-only, treat it as a write
 * and require an approval prompt. Only the literal string "read" is
 * accepted as read-only; every other value (including null, missing field,
 * empty string, whitespace, and case variants like "Read" or "READ") is
 * classified as "write".
 */
public with sharing class OperationClassifier {

    public static final String READ = 'read';
    public static final String WRITE = 'write';

    private OperationClassifier() {}

    /**
     * Classifies a pending-operation announcement as 'read' or 'write'.
     *
     * Fail-safe: returns 'write' unless `pendingOperation` is a Map whose
     * `classification` key is exactly the string "read". Any other shape or
     * value - including null input, non-Map input, missing key, null value,
     * empty string, or case variants - returns 'write' so the
     * human-in-the-loop approval gate is always engaged on ambiguity.
     *
     * @param pendingOperation the `pendingOperation` object from the MCP
     *        response (typically a Map<String, Object> deserialized via
     *        JSON.deserializeUntyped)
     * @return 'read' or 'write'
     */
    public static String classifyOperation(Object pendingOperation) {
        if (pendingOperation == null) {
            return WRITE;
        }
        if (!(pendingOperation instanceof Map<String, Object>)) {
            return WRITE;
        }
        Map<String, Object> m = (Map<String, Object>) pendingOperation;
        Object c = m.get('classification');
        if (c == null) {
            return WRITE;
        }
        if (!(c instanceof String)) {
            return WRITE;
        }
        String s = (String) c;
        // Case-sensitive exact match - 'Read', 'READ', 'read ', ' read' all
        // fall through to WRITE. This is deliberate (Req 6.9 fail-safe).
        if (READ.equals(s)) {
            return READ;
        }
        return WRITE;
    }
}
