/**
 * Feature: partner-central-chat-agent
 *
 * Pure redactor for audit-log persistence. Implements Req 10.3: the raw
 * base64 contents of user Attachments MUST NEVER be written to
 * `Audit_Log__c`. Instead, every attachment node in a JSON-RPC `params`
 * structure is rewritten to the safe metadata form
 * `{ fileName, mimeType, sizeBytes, sha256 }` and all other (non-attachment)
 * fields pass through unchanged.
 *
 * An "attachment node" is any Map that contains a `contentBase64` key.
 * This mirrors the JSON-RPC request schema in design.md where
 * `AttachmentDto.base64Content` is serialized on the wire as
 * `contentBase64`.
 *
 * This class is pure: no DML, no callouts, no platform dependencies.
 * It operates on a `Map<String, Object>` (the shape produced by
 * `JSON.deserializeUntyped`) and returns a JSON string suitable for
 * `Audit_Log__c.Request_Params_Redacted__c`.
 */
public with sharing class AuditRedactor {

    private static final String KEY_CONTENT_BASE64 = 'contentBase64';
    private static final String KEY_FILE_NAME = 'fileName';
    private static final String KEY_MIME_TYPE = 'mimeType';
    private static final String KEY_SIZE_BYTES = 'sizeBytes';
    private static final String KEY_SHA256 = 'sha256';

    private AuditRedactor() {}

    /**
     * Redacts any attachment payloads embedded in `params` and returns a
     * JSON string safe to persist to `Audit_Log__c.Request_Params_Redacted__c`.
     *
     * Recursively walks Maps and Lists: any Map containing a `contentBase64`
     * entry is replaced with `{fileName, mimeType, sizeBytes, sha256}` where
     * `sha256` is the SHA-256 hex digest of the raw base64 bytes (omitted
     * when `contentBase64` is null or empty). All other fields are
     * preserved verbatim.
     *
     * @param params the deserialized params map (as produced by
     *        `JSON.deserializeUntyped` or built directly)
     * @return a JSON string with every attachment redacted; an empty JSON
     *         object (`{}`) when `params` is null
     */
    public static String redactParams(Map<String, Object> params) {
        if (params == null) {
            return '{}';
        }
        return JSON.serialize(redactValue(params));
    }

    /**
     * Recursively redacts an arbitrary value. Maps with a `contentBase64`
     * key are collapsed to the safe attachment metadata form; other Maps
     * and Lists are descended into; primitives are returned as-is.
     */
    private static Object redactValue(Object value) {
        if (value instanceof Map<String, Object>) {
            Map<String, Object> m = (Map<String, Object>) value;
            if (m.containsKey(KEY_CONTENT_BASE64)) {
                return toAttachmentRef(m);
            }
            Map<String, Object> out = new Map<String, Object>();
            for (String k : m.keySet()) {
                out.put(k, redactValue(m.get(k)));
            }
            return out;
        }
        if (value instanceof List<Object>) {
            List<Object> src = (List<Object>) value;
            List<Object> out = new List<Object>();
            for (Object item : src) {
                out.add(redactValue(item));
            }
            return out;
        }
        return value;
    }

    /**
     * Builds the safe `{fileName, mimeType, sizeBytes, sha256}` projection
     * from an attachment node. Only these keys are emitted; `contentBase64`
     * and any other fields on the original attachment Map are dropped.
     */
    private static Map<String, Object> toAttachmentRef(Map<String, Object> attachment) {
        Map<String, Object> ref = new Map<String, Object>();
        ref.put(KEY_FILE_NAME, attachment.get(KEY_FILE_NAME));
        ref.put(KEY_MIME_TYPE, attachment.get(KEY_MIME_TYPE));
        ref.put(KEY_SIZE_BYTES, attachment.get(KEY_SIZE_BYTES));
        String sha256 = hashBase64(attachment.get(KEY_CONTENT_BASE64));
        if (sha256 != null) {
            ref.put(KEY_SHA256, sha256);
        }
        return ref;
    }

    /**
     * Computes a SHA-256 hex digest of the raw bytes represented by a
     * base64 string. Returns null for null/empty/non-String input or when
     * the value cannot be base64-decoded; the caller then omits the
     * optional `sha256` field.
     */
    private static String hashBase64(Object contentBase64) {
        if (contentBase64 == null || !(contentBase64 instanceof String)) {
            return null;
        }
        String b64 = (String) contentBase64;
        if (String.isEmpty(b64)) {
            return null;
        }
        try {
            Blob raw = EncodingUtil.base64Decode(b64);
            Blob digest = Crypto.generateDigest('SHA-256', raw);
            return EncodingUtil.convertToHex(digest);
        } catch (Exception e) {
            return null;
        }
    }
}
