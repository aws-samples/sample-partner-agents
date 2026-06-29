/**
 * Feature: partner-central-chat-agent
 *
 * JSON-RPC 2.0 response value class.
 *
 * Per the JSON-RPC 2.0 spec, a response contains either `result` (success) or
 * `error` (failure), never both. We use `error == null` as the authoritative
 * success check because `result` may legitimately be `null` in rare cases.
 *
 * Public fields (not getters/setters) are used so `JSON.serialize` /
 * `JSON.deserialize` can round-trip instances. Structural `equals` / `hashCode`
 * support property-based round-trip tests.
 *
 * See requirements 3.3, 3.6.
 */
public with sharing class JsonRpcResponse {

    /** JSON-RPC protocol version; always "2.0" for a compliant response. */
    public static final String JSONRPC_VERSION = '2.0';

    // Public instance fields (JSON.serialize / JSON.deserialize target these directly).
    public String jsonrpc;
    public String id;
    public Object result;
    public JsonRpcError error;

    /**
     * No-arg constructor required by `JSON.deserialize`. Seeds `jsonrpc` so
     * hand-built responses are still valid by default.
     */
    public JsonRpcResponse() {
        this.jsonrpc = JSONRPC_VERSION;
    }

    /** Full-args constructor. Always stamps `jsonrpc` with the protocol constant. */
    public JsonRpcResponse(String id, Object result, JsonRpcError error) {
        this.jsonrpc = JSONRPC_VERSION;
        this.id = id;
        this.result = result;
        this.error = error;
    }

    /**
     * True when this response represents a successful invocation. A `null`
     * `error` is the spec-defined signal of success; `result` can legitimately
     * be `null` for void methods.
     */
    public Boolean isSuccess() {
        return this.error == null;
    }

    /**
     * Structural equality. `result` is compared via canonical JSON
     * serialization because it is declared `Object`; `error` delegates to
     * `JsonRpcError.equals`.
     */
    public Boolean equals(Object obj) {
        if (obj == null) { return false; }
        if (!(obj instanceof JsonRpcResponse)) { return false; }
        JsonRpcResponse other = (JsonRpcResponse) obj;
        return stringsEqual(this.jsonrpc, other.jsonrpc)
            && stringsEqual(this.id, other.id)
            && JSON.serialize(this.result) == JSON.serialize(other.result)
            && errorsEqual(this.error, other.error);
    }

    /** Hash derived from the same fields used by `equals`. */
    public Integer hashCode() {
        String composite =
            String.valueOf(this.jsonrpc) + '|' +
            String.valueOf(this.id) + '|' +
            JSON.serialize(this.result) + '|' +
            (this.error == null ? 'null' : String.valueOf(this.error.hashCode()));
        return composite.hashCode();
    }

    private static Boolean stringsEqual(String a, String b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a.equals(b);
    }

    private static Boolean errorsEqual(JsonRpcError a, JsonRpcError b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a.equals(b);
    }
}
