/**
 * Feature: partner-central-chat-agent
 *
 * JSON-RPC 2.0 error object. Appears as the `error` field on a
 * `JsonRpcResponse` when the remote method invocation fails.
 *
 * Public fields are used so `JSON.serialize` / `JSON.deserialize` can
 * round-trip instances. Structural `equals` / `hashCode` support property-based
 * round-trip comparisons.
 *
 * See requirements 3.3, 3.6.
 */
public with sharing class JsonRpcError {

    // Public instance fields per JSON-RPC 2.0 spec.
    public Integer code;
    public String message;
    public Object data;

    /** No-arg constructor required by `JSON.deserialize`. */
    public JsonRpcError() {}

    /** Full-args constructor. */
    public JsonRpcError(Integer code, String message, Object data) {
        this.code = code;
        this.message = message;
        this.data = data;
    }

    /**
     * Structural equality. `data` is compared via canonical JSON serialization
     * because it is declared `Object` and may hold arbitrary Map/List trees.
     */
    public Boolean equals(Object obj) {
        if (obj == null) { return false; }
        if (!(obj instanceof JsonRpcError)) { return false; }
        JsonRpcError other = (JsonRpcError) obj;
        return integersEqual(this.code, other.code)
            && stringsEqual(this.message, other.message)
            && JSON.serialize(this.data) == JSON.serialize(other.data);
    }

    /** Hash derived from the same fields used by `equals`. */
    public Integer hashCode() {
        String composite =
            String.valueOf(this.code) + '|' +
            String.valueOf(this.message) + '|' +
            JSON.serialize(this.data);
        return composite.hashCode();
    }

    private static Boolean stringsEqual(String a, String b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a.equals(b);
    }

    private static Boolean integersEqual(Integer a, Integer b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a == b;
    }
}
