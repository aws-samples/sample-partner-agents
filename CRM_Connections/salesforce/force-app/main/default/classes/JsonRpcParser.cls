/**
 * Feature: partner-central-chat-agent
 *
 * Pure-Apex parser for JSON-RPC 2.0 request and response payloads. Companion
 * to `JsonRpcSerializer`; together they provide the round-trip property
 * required by Req 3.4 / 3.5. Kept free of platform dependencies (no DML, no
 * callouts, no @AuraEnabled) so it is trivially exercised from property-based
 * tests and unit tests.
 *
 * The parser uses `JSON.deserializeUntyped` so that arbitrary nested `params`
 * / `result` / `error.data` trees (Map, List, primitives) are preserved as
 * generic Apex `Object` values — matching how `JsonRpcSerializer` emits them.
 * We deliberately avoid `JSON.deserialize(json, Type.class)` because it would
 * impose the DTO's strict type definitions on fields that the JSON-RPC spec
 * defines as open-shape.
 *
 * Error-reporting contract (Req 3.7): every `JsonRpcParseException` thrown by
 * this class names the offending field concretely (for example
 * `"Missing required field 'jsonrpc'"` or `"Invalid type for 'id': expected
 * String or Integer but got List"`) so the Chat_Agent LWC can surface the
 * message to the user without additional formatting.
 *
 * See requirements 3.3, 3.5, 3.7.
 */
public with sharing class JsonRpcParser {

    /** JSON-RPC protocol version this parser enforces on every payload. */
    private static final String JSONRPC_VERSION = '2.0';

    /**
     * Private constructor — this class exposes only static methods and holds
     * no instance state.
     */
    private JsonRpcParser() {}

    /**
     * Parses a JSON-RPC 2.0 request payload into a `JsonRpcRequest` DTO.
     *
     * Used on the inbound path for scenarios where the MCP_Server echoes a
     * request shape back to the client (for example, approval echoes on
     * pending Write_Operations). Validates the structural contract defined by
     * the JSON-RPC 2.0 spec; on any violation, throws a
     * `JsonRpcParseException` whose message names the offending field.
     *
     * @param json the payload to parse; must be a JSON object literal
     * @return a populated `JsonRpcRequest`
     * @throws JsonRpcParseException if the payload is malformed JSON or
     *         violates the JSON-RPC 2.0 request contract
     */
    public static JsonRpcRequest parseRequest(String payload) {
        Map<String, Object> root = deserializeRoot(payload);

        JsonRpcRequest req = new JsonRpcRequest();
        req.jsonrpc = readJsonrpcVersion(root);
        req.id = readId(root, true /* idRequired */);
        req.method = readMethod(root);
        req.params = readParams(root);

        return req;
    }

    /**
     * Parses a JSON-RPC 2.0 response payload into a `JsonRpcResponse` DTO.
     *
     * Validates that exactly one of `result` / `error` is present, per the
     * JSON-RPC 2.0 spec. The `result` field is preserved as a raw
     * `Map<String, Object>` / `List<Object>` / primitive tree (typed as
     * `Object`) so downstream callers can inspect it without additional
     * parsing — see `extractSessionId` for the canonical Session_ID lookup.
     *
     * @param json the payload to parse; must be a JSON object literal
     * @return a populated `JsonRpcResponse`
     * @throws JsonRpcParseException if the payload is malformed JSON or
     *         violates the JSON-RPC 2.0 response contract
     */
    public static JsonRpcResponse parseResponse(String payload) {
        Map<String, Object> root = deserializeRoot(payload);

        JsonRpcResponse resp = new JsonRpcResponse();
        resp.jsonrpc = readJsonrpcVersion(root);
        resp.id = readId(root, true /* idRequired */);

        Boolean hasResultKey = root.containsKey('result');
        Boolean hasErrorKey = root.containsKey('error');

        // The JSON-RPC 2.0 spec mandates exactly one of result/error. Both
        // present or both absent are protocol violations and must not be
        // silently tolerated.
        if (hasResultKey && hasErrorKey) {
            throw new JsonRpcParseException(
                'Response cannot contain both \'result\' and \'error\' fields'
            );
        }
        if (!hasResultKey && !hasErrorKey) {
            throw new JsonRpcParseException(
                'Response must contain either \'result\' or \'error\' field'
            );
        }

        if (hasResultKey) {
            // result may legitimately be null for void methods; we simply
            // preserve whatever was on the wire.
            resp.result = root.get('result');
            resp.error = null;
        } else {
            resp.result = null;
            resp.error = readError(root.get('error'));
        }

        return resp;
    }

    /**
     * Extracts the MCP-returned Session_ID embedded in a successful response
     * body. Per the design's MCP schemas, a success result takes the shape
     * `{ "sessionId": "s-abc123", "message": {...}, "pendingOperations": [...] }`.
     *
     * Fully null-safe: returns null if the response is null, if the response
     * is an error variant, if `result` is not a Map, or if the Map has no
     * `sessionId` key or the value is not a String.
     *
     * @param resp response to inspect; may be null
     * @return the Session_ID string if present and well-formed, else null
     */
    public static String extractSessionId(JsonRpcResponse resp) {
        if (resp == null || resp.result == null) {
            return null;
        }
        if (!(resp.result instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> resultMap = (Map<String, Object>) resp.result;
        Object sid = resultMap.get('sessionId');
        if (sid == null) {
            return null;
        }
        if (sid instanceof String) {
            return (String) sid;
        }
        // A non-String sessionId is not spec-compliant; treat as absent rather
        // than throw, because `extractSessionId` is a convenience accessor and
        // the stricter response-shape validation belongs in `parseResponse`.
        return null;
    }

    // ---- Internal helpers ---------------------------------------------------

    /**
     * Deserializes the raw JSON text into a `Map<String, Object>`. Rejects
     * non-object roots (arrays, primitives) because both JSON-RPC requests
     * and responses must be JSON objects.
     */
    private static Map<String, Object> deserializeRoot(String payload) {
        if (payload == null) {
            throw new JsonRpcParseException('Payload cannot be null');
        }

        Object raw;
        try {
            raw = JSON.deserializeUntyped(payload);
        } catch (System.JSONException je) {
            // Chain the underlying parser message so diagnostic tooling can
            // surface the exact offset that the platform JSON parser reported.
            throw new JsonRpcParseException(
                'Malformed JSON payload: ' + je.getMessage()
            );
        }

        if (!(raw instanceof Map<String, Object>)) {
            throw new JsonRpcParseException(
                'Root must be a JSON object but got ' + describeType(raw)
            );
        }
        return (Map<String, Object>) raw;
    }

    /**
     * Validates the `jsonrpc` field and returns its value. Enforces the
     * literal "2.0" required by the spec.
     */
    private static String readJsonrpcVersion(Map<String, Object> root) {
        if (!root.containsKey('jsonrpc')) {
            throw new JsonRpcParseException('Missing required field \'jsonrpc\'');
        }
        Object v = root.get('jsonrpc');
        if (!(v instanceof String)) {
            throw new JsonRpcParseException(
                'Invalid type for \'jsonrpc\': expected String but got ' + describeType(v)
            );
        }
        String s = (String) v;
        if (s != JSONRPC_VERSION) {
            throw new JsonRpcParseException(
                'Invalid value for \'jsonrpc\': expected "2.0" but got "' + s + '"'
            );
        }
        return s;
    }

    /**
     * Reads the JSON-RPC `id` field. The spec allows String, Integer, or null.
     * Our DTOs use String, so we coerce numeric ids via `String.valueOf`.
     * When `idRequired` is true and the key is absent, throws; when present
     * but null, returns null.
     */
    private static String readId(Map<String, Object> root, Boolean idRequired) {
        if (!root.containsKey('id')) {
            if (idRequired) {
                throw new JsonRpcParseException('Missing required field \'id\'');
            }
            return null;
        }
        Object v = root.get('id');
        if (v == null) {
            // The JSON-RPC spec reserves null id for notifications, but
            // responses also permit null id when the request id could not be
            // determined. Either way, null is a legal value here.
            return null;
        }
        if (v instanceof String) {
            return (String) v;
        }
        // JSON numbers deserialize as Long / Integer / Double / Decimal
        // depending on magnitude and presence of a decimal point. The spec
        // strongly discourages fractional ids, but we still normalize all
        // numeric variants to the canonical String form so downstream code
        // never has to branch on numeric type.
        if (v instanceof Integer
            || v instanceof Long
            || v instanceof Double
            || v instanceof Decimal) {
            return String.valueOf(v);
        }
        throw new JsonRpcParseException(
            'Invalid type for \'id\': expected String or Integer but got ' + describeType(v)
        );
    }

    /** Reads and validates the request `method` field. Must be a non-empty String. */
    private static String readMethod(Map<String, Object> root) {
        if (!root.containsKey('method')) {
            throw new JsonRpcParseException('Missing required field \'method\'');
        }
        Object v = root.get('method');
        if (!(v instanceof String)) {
            throw new JsonRpcParseException(
                'Invalid type for \'method\': expected String but got ' + describeType(v)
            );
        }
        String s = (String) v;
        if (String.isBlank(s)) {
            throw new JsonRpcParseException('Field \'method\' must be a non-empty String');
        }
        return s;
    }

    /**
     * Reads the optional `params` field. JSON-RPC 2.0 permits both object and
     * array params, but our MCP usage exclusively uses object (Map) params,
     * so we reject List inputs with a clear message rather than silently
     * coerce them.
     */
    private static Map<String, Object> readParams(Map<String, Object> root) {
        if (!root.containsKey('params')) {
            return null;
        }
        Object v = root.get('params');
        if (v == null) {
            return null;
        }
        if (v instanceof Map<String, Object>) {
            return (Map<String, Object>) v;
        }
        throw new JsonRpcParseException(
            'Invalid type for \'params\': expected object but got ' + describeType(v)
        );
    }

    /**
     * Parses the `error` object on a failed response into a `JsonRpcError`.
     * Requires `code` (Integer) and `message` (String); `data` is optional
     * and preserved as an opaque `Object` tree.
     */
    private static JsonRpcError readError(Object raw) {
        if (raw == null) {
            throw new JsonRpcParseException('Field \'error\' must not be null');
        }
        if (!(raw instanceof Map<String, Object>)) {
            throw new JsonRpcParseException(
                'Invalid type for \'error\': expected object but got ' + describeType(raw)
            );
        }
        Map<String, Object> errMap = (Map<String, Object>) raw;

        if (!errMap.containsKey('code')) {
            throw new JsonRpcParseException('Missing required field \'error.code\'');
        }
        Object codeObj = errMap.get('code');
        Integer code;
        if (codeObj instanceof Integer) {
            code = (Integer) codeObj;
        } else if (codeObj instanceof Long) {
            // Apex commonly deserializes small JSON integers as Long; coerce.
            code = ((Long) codeObj).intValue();
        } else {
            throw new JsonRpcParseException(
                'Invalid type for \'error.code\': expected Integer but got ' + describeType(codeObj)
            );
        }

        if (!errMap.containsKey('message')) {
            throw new JsonRpcParseException('Missing required field \'error.message\'');
        }
        Object msgObj = errMap.get('message');
        if (!(msgObj instanceof String)) {
            throw new JsonRpcParseException(
                'Invalid type for \'error.message\': expected String but got ' + describeType(msgObj)
            );
        }

        // `data` is optional. Absent key and explicit null both normalize to
        // a null `data` field on the DTO.
        Object data = errMap.containsKey('data') ? errMap.get('data') : null;

        return new JsonRpcError(code, (String) msgObj, data);
    }

    /**
     * Returns a human-readable type name for error messages. Covers the Apex
     * types that `JSON.deserializeUntyped` can produce; falls back to the
     * literal `Object` for anything unexpected.
     */
    private static String describeType(Object v) {
        if (v == null) { return 'null'; }
        if (v instanceof Map<String, Object>) { return 'object'; }
        if (v instanceof List<Object>) { return 'List'; }
        if (v instanceof String) { return 'String'; }
        if (v instanceof Boolean) { return 'Boolean'; }
        if (v instanceof Integer) { return 'Integer'; }
        if (v instanceof Long) { return 'Long'; }
        if (v instanceof Double) { return 'Double'; }
        if (v instanceof Decimal) { return 'Decimal'; }
        return 'Object';
    }
}
