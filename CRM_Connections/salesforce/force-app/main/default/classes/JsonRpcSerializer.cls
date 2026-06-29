/**
 * Feature: partner-central-chat-agent
 *
 * Pure-Apex serializer for JSON-RPC 2.0 requests and responses. Kept free of
 * platform dependencies (no DML, no callouts, no @AuraEnabled) so it can be
 * exercised directly from property-based tests and unit tests.
 *
 * Serialization goes through `JSON.serialize(Map<String, Object>)` so that
 * arbitrary nested `params` / `result` / `error.data` trees built from Map,
 * List, and primitive values round-trip losslessly. We deliberately avoid
 * `JSON.serialize(Object)` on the DTO itself because it would walk the Apex
 * type definitions and lose the "raw Map tree" shape that the JSON-RPC spec
 * requires for `params`.
 *
 * See requirements 3.1, 3.4, 3.5.
 */
public with sharing class JsonRpcSerializer {

    /** JSON-RPC protocol version this serializer enforces on every payload. */
    private static final String JSONRPC_VERSION = '2.0';

    /**
     * Private constructor — this class exposes only static methods and holds
     * no instance state.
     */
    private JsonRpcSerializer() {}

    /**
     * Serializes a JSON-RPC 2.0 request into its canonical JSON string form.
     *
     * The output shape is `{ "jsonrpc": "2.0", "id": "...", "method": "...",
     * "params": {...} }`. Per the JSON-RPC 2.0 spec, `params` is optional, so
     * when `req.params` is `null` the `params` key is omitted entirely rather
     * than emitted as `"params": null`.
     *
     * @param req the request DTO to serialize; must be non-null and must have
     *            `jsonrpc == "2.0"`
     * @return canonical JSON string representation
     * @throws IllegalArgumentException if `req` is null
     * @throws JsonRpcSerializationException if `req.jsonrpc` is not "2.0"
     */
    public static String serialize(JsonRpcRequest req) {
        if (req == null) {
            throw new IllegalArgumentException(
                'JsonRpcSerializer.serialize: request cannot be null'
            );
        }
        if (req.jsonrpc != JSONRPC_VERSION) {
            throw new JsonRpcSerializationException(
                'JsonRpcSerializer.serialize: jsonrpc field must be "2.0" but was ' +
                String.valueOf(req.jsonrpc)
            );
        }

        // Build the wire map explicitly so the raw params Map/List/primitive
        // tree is preserved. `JsonRpcRequest.toMap()` always includes the
        // params key; we strip it when params is null to comply with the
        // JSON-RPC 2.0 "params MAY be omitted" rule.
        Map<String, Object> wire = new Map<String, Object>();
        wire.put('jsonrpc', req.jsonrpc);
        wire.put('id', req.id);
        wire.put('method', req.method);
        if (req.params != null) {
            wire.put('params', req.params);
        }

        return JSON.serialize(wire);
    }

    /**
     * Serializes a JSON-RPC 2.0 response (success or error variant) into its
     * canonical JSON string form.
     *
     * Success outputs `{ "jsonrpc": "2.0", "id": "...", "result": ... }` and
     * omits the `error` key. Error outputs `{ "jsonrpc": "2.0", "id": "...",
     * "error": { "code": ..., "message": ..., "data": ... } }` and omits the
     * `result` key. The spec forbids a response that carries both fields or
     * neither field, so either configuration triggers a
     * `JsonRpcSerializationException`.
     *
     * @param resp the response DTO to serialize; must be non-null
     * @return canonical JSON string representation
     * @throws IllegalArgumentException if `resp` is null
     * @throws JsonRpcSerializationException if the response has both `result`
     *         and `error` set, or has neither set
     */
    public static String serialize(JsonRpcResponse resp) {
        if (resp == null) {
            throw new IllegalArgumentException(
                'JsonRpcSerializer.serialize: response cannot be null'
            );
        }

        Boolean hasResult = resp.result != null;
        Boolean hasError = resp.error != null;

        // `isSuccess()` is our authoritative success signal (error == null),
        // but we still enforce the spec-level invariant that exactly one of
        // result/error is populated. A "success with null result" (void
        // method) is legitimate per JSON-RPC 2.0, so we only reject the
        // both-set and the error-branch-with-no-error cases.
        if (hasResult && hasError) {
            throw new JsonRpcSerializationException(
                'JsonRpcSerializer.serialize: response cannot carry both result and error'
            );
        }
        if (!resp.isSuccess() && !hasError) {
            // isSuccess() returned false, so error should have been present.
            // This branch is defensive; currently unreachable because
            // isSuccess() is defined as `error == null`.
            throw new JsonRpcSerializationException(
                'JsonRpcSerializer.serialize: failed response must include an error object'
            );
        }

        Map<String, Object> wire = new Map<String, Object>();
        wire.put('jsonrpc', resp.jsonrpc);
        wire.put('id', resp.id);

        if (resp.isSuccess()) {
            wire.put('result', resp.result);
        } else {
            wire.put('error', errorToMap(resp.error));
        }

        return JSON.serialize(wire);
    }

    /**
     * Converts a `JsonRpcError` into a plain Map so `JSON.serialize` emits the
     * `{code, message, data}` shape without walking the DTO's Apex type
     * definition. `data` is preserved as-is (may be any Map / List / primitive
     * tree) for lossless round-tripping.
     */
    private static Map<String, Object> errorToMap(JsonRpcError err) {
        Map<String, Object> m = new Map<String, Object>();
        m.put('code', err.code);
        m.put('message', err.message);
        // `data` is optional per the JSON-RPC 2.0 spec. Omitting the key when
        // it is null keeps error payloads compact and matches the canonical
        // wire example in the design doc. Round-trip correctness is preserved
        // because `JsonRpcParser` maps an absent `data` key back to `null`.
        if (err.data != null) {
            m.put('data', err.data);
        }
        return m;
    }
}
