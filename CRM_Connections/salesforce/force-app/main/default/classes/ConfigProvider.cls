/**
 * Feature: partner-central-chat-agent
 *
 * Runtime accessor for the `Chat_Agent_Config__mdt.Default` record.
 *
 * Design points:
 *  - No static cross-transaction cache: every new Apex transaction re-reads the
 *    metadata record so admin edits take effect on the next user-initiated
 *    message without a deployment (Req 12.2).
 *  - Per-transaction memoization via `cachedRecord` keeps repeated getter calls
 *    within a single request from hitting SOQL more than once.
 *  - Fail-closed: any required field that is null causes `ChatAgentConfigException`
 *    naming the missing field, so the controller can surface a configuration
 *    error and avoid sending anything to the MCP server (Req 12.3).
 *  - `getActiveNamedCredentialName()` centralizes the sandbox/production choice
 *    so callers don't re-implement it (Req 13.1).
 *
 * See requirements 12.1, 12.2, 12.3, 13.1.
 */
public with sharing class ConfigProvider {

    private static final String DEFAULT_DEVELOPER_NAME = 'Default';

    // AWS Partner CRM Connector's settings object and sandbox flag field.
    // The connector ships as a managed package under the `awsapn__`
    // namespace; when installed on the org it exposes a singleton
    // settings record that admins use to toggle between AWS production
    // and the Partner Central sandbox. We read it defensively via
    // `Schema.getGlobalDescribe()` so orgs that do NOT have the
    // connector installed continue to work.
    private static final String CONNECTOR_SETTINGS_OBJECT =
        'awsapn__Companion_App_Settings__c';
    private static final String CONNECTOR_SANDBOX_FIELD =
        'awsapn__PC_API_Sandbox_Enabled__c';

    @TestVisible
    private static Chat_Agent_Config__mdt cachedRecord;

    // Per-transaction memoization for the connector sandbox probe so the
    // dynamic SOQL runs at most once per request. `connectorSandboxProbed`
    // tracks whether we've attempted the probe — distinguishing "unknown"
    // from "known null" without needing a tri-state Boolean.
    @TestVisible
    private static Boolean connectorSandboxProbed = false;
    @TestVisible
    private static Boolean connectorSandboxCached = null;
    @TestVisible
    private static Boolean connectorSandboxOverride = null;

    public static String getNamedCredentialName() {
        return load().Named_Credential_Name__c;
    }

    public static String getActiveNamedCredentialName() {
        Chat_Agent_Config__mdt cfg = load();
        // Key off the RESOLVED catalog (isSandbox), not the raw config
        // flag, so the credential always matches the catalog even when the
        // connector setting supersedes the config flag. When no dedicated
        // sandbox credential is configured, fall back to the base
        // credential: the MCP endpoint is identical for both catalogs (the
        // catalog travels as a request parameter), so one credential can
        // serve both.
        if (isSandbox()) {
            return String.isNotBlank(cfg.Sandbox_Named_Credential_Name__c)
                ? cfg.Sandbox_Named_Credential_Name__c
                : cfg.Named_Credential_Name__c;
        }
        return cfg.Named_Credential_Name__c;
    }

    public static Integer getRequestTimeoutSeconds() {
        return load().Request_Timeout_Seconds__c.intValue();
    }

    public static Integer getSessionRetentionMinutes() {
        return load().Session_Retention_Minutes__c.intValue();
    }

    public static Long getMaxAttachmentSizeBytes() {
        return load().Max_Attachment_Size_Bytes__c.longValue();
    }

    public static List<String> getAllowedMimeTypes() {
        String raw = load().Allowed_Mime_Types__c;
        List<String> result = new List<String>();
        for (String part : raw.split(',')) {
            String trimmed = part.trim();
            if (String.isNotBlank(trimmed)) {
                result.add(trimmed);
            }
        }
        return result;
    }

    /**
     * Returns true when the next MCP turn should target the Partner
     * Central `Sandbox` catalog, false for `AWS` (production).
     *
     * Resolution order (first win):
     *   1. The AWS Partner CRM Connector's
     *      `awsapn__Companion_App_Settings__c.awsapn__PC_API_Sandbox_Enabled__c`
     *      flag, whenever the connector is installed. This is the
     *      authoritative control for orgs that have the connector:
     *      partner admins toggle Sandbox/AWS there and expect the chat
     *      agent to follow, configuring the environment once. Because it
     *      wins, installing the connector later automatically supersedes
     *      (and silently ignores) the standalone config flag below.
     *   2. `Chat_Agent_Config__mdt.Default.Is_Sandbox__c` as the
     *      standalone fallback, used only when no connector is present.
     *      This is the deploy-time catalog choice for standalone
     *      deployments (defaults to the workshop's Sandbox-first value).
     */
    public static Boolean isSandbox() {
        // Connector setting is authoritative when the connector is
        // installed; the config flag is only consulted standalone.
        Boolean connector = detectConnectorSandbox();
        if (connector != null) {
            return connector;
        }
        return load().Is_Sandbox__c == true;
    }

    /**
     * Probes the AWS Partner CRM Connector's Companion App Settings for
     * its sandbox flag. Returns:
     *   - `true` when the connector is installed AND the sandbox flag
     *     is `true`,
     *   - `false` when the connector is installed AND the sandbox flag
     *     is `false`,
     *   - `null` when the connector is not installed, the field is not
     *     present, no settings row exists, or the probe failed for any
     *     reason — signalling "no authoritative setting, caller should
     *     fall back".
     *
     * Probe result is cached per-transaction so concurrent getters don't
     * each issue a SOQL. The probe is wrapped in try/catch so a missing
     * managed package, FLS denial, or any other runtime hiccup returns
     * null rather than breaking the whole request.
     */
    @TestVisible
    public static Boolean detectConnectorSandbox() {
        if (connectorSandboxOverride != null) {
            return connectorSandboxOverride;
        }
        if (connectorSandboxProbed) {
            return connectorSandboxCached;
        }
        connectorSandboxProbed = true;
        try {
            Schema.SObjectType sot =
                Schema.getGlobalDescribe().get(CONNECTOR_SETTINGS_OBJECT);
            if (sot == null) {
                // Connector not installed on this org.
                connectorSandboxCached = null;
                return null;
            }
            Map<String, Schema.SObjectField> fields =
                sot.getDescribe().fields.getMap();
            if (!fields.containsKey(CONNECTOR_SANDBOX_FIELD.toLowerCase())) {
                // Connector installed but an older/newer version missing
                // the sandbox flag field.
                connectorSandboxCached = null;
                return null;
            }
            String soql = 'SELECT ' + CONNECTOR_SANDBOX_FIELD
                + ' FROM ' + CONNECTOR_SETTINGS_OBJECT
                + ' LIMIT 1';
            List<SObject> rows = Database.query(soql);
            if (rows.isEmpty()) {
                connectorSandboxCached = null;
                return null;
            }
            Object val = rows[0].get(CONNECTOR_SANDBOX_FIELD);
            if (val == null) {
                connectorSandboxCached = null;
                return null;
            }
            connectorSandboxCached = (Boolean) val;
            return connectorSandboxCached;
        } catch (Exception e) {
            // Any failure (missing package, FLS, namespace changes) is
            // treated as "no authoritative setting". The next getter
            // call falls back to the config record's flag.
            connectorSandboxCached = null;
            return null;
        }
    }

    public static Boolean isSseEnabled() {
        return load().Sse_Enabled__c == true;
    }

    // -----------------------------------------------------------------
    // File-attachment upload (S3) configuration
    // -----------------------------------------------------------------
    // These three are optional: text chat works without them. They are
    // required only when a user attaches a file, in which case
    // McpClient.uploadAttachmentToS3 fails closed with a clear message if
    // any is blank. The MCP endpoint is identical for both catalogs, but
    // S3 upload always targets the production ephemeral bucket via its own
    // SigV4 Named Credential (service `s3`).

    public static String getS3NamedCredentialName() {
        return load().S3_Named_Credential_Name__c;
    }

    public static String getS3BucketName() {
        return load().S3_Bucket_Name__c;
    }

    public static String getAwsAccountId() {
        return load().Aws_Account_Id__c;
    }

    @TestVisible
    private static void clearCache() {
        cachedRecord = null;
        connectorSandboxProbed = false;
        connectorSandboxCached = null;
        connectorSandboxOverride = null;
    }

    /**
     * Test-only hook to inject a connector sandbox value without needing
     * the managed package installed in the test namespace. When non-null,
     * `detectConnectorSandbox()` returns this value verbatim and skips
     * the SOQL probe entirely.
     */
    @TestVisible
    private static void setConnectorSandboxOverride(Boolean value) {
        connectorSandboxOverride = value;
        connectorSandboxProbed = (value != null);
        connectorSandboxCached = value;
    }

    private static Chat_Agent_Config__mdt load() {
        if (cachedRecord != null) {
            return cachedRecord;
        }
        List<Chat_Agent_Config__mdt> rows = [
            SELECT Named_Credential_Name__c,
                   Sandbox_Named_Credential_Name__c,
                   Is_Sandbox__c,
                   Request_Timeout_Seconds__c,
                   Session_Retention_Minutes__c,
                   Max_Attachment_Size_Bytes__c,
                   Allowed_Mime_Types__c,
                   Sse_Enabled__c,
                   S3_Named_Credential_Name__c,
                   S3_Bucket_Name__c,
                   Aws_Account_Id__c
            FROM Chat_Agent_Config__mdt
            WHERE DeveloperName = :DEFAULT_DEVELOPER_NAME
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Default record not found'
            );
        }
        Chat_Agent_Config__mdt cfg = rows[0];
        validate(cfg);
        cachedRecord = cfg;
        return cachedRecord;
    }

    @TestVisible
    private static void validate(Chat_Agent_Config__mdt cfg) {
        if (String.isBlank(cfg.Named_Credential_Name__c)) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Named_Credential_Name__c is required'
            );
        }
        if (cfg.Request_Timeout_Seconds__c == null) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Request_Timeout_Seconds__c is required'
            );
        }
        if (cfg.Session_Retention_Minutes__c == null) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Session_Retention_Minutes__c is required'
            );
        }
        if (cfg.Max_Attachment_Size_Bytes__c == null) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Max_Attachment_Size_Bytes__c is required'
            );
        }
        if (String.isBlank(cfg.Allowed_Mime_Types__c)) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Allowed_Mime_Types__c is required'
            );
        }
        if (cfg.Is_Sandbox__c == true
            && String.isBlank(cfg.Sandbox_Named_Credential_Name__c)) {
            throw new ChatAgentConfigException(
                'Chat_Agent_Config__mdt.Sandbox_Named_Credential_Name__c is required when Is_Sandbox__c is true'
            );
        }
    }
}
