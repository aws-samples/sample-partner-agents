/**
 * Feature: partner-central-chat-agent
 *
 * The Chat Agent LWC. Single long-lived component placed on a record page,
 * app page, or utility bar. Responsible for:
 *   - bootstrapping the client config and prior transcript from Apex,
 *   - collecting user input (text + attachments) with client-side validation,
 *   - subscribing to `/event/Chat_Stream_Event__e` to render streamed
 *     assistant responses keyed on the in-flight transcript entry id,
 *   - rendering inline approval cards when the agent requests a human
 *     decision, and invoking `decideOperation` on click,
 *   - surfacing structured error envelopes (`ChatAgentResult`) with a
 *     retryable/non-retryable distinction and a Named-Credential-aware
 *     message on 401/403.
 *
 * Safety invariants:
 *   - On `disconnectedCallback`, unsubscribe from empApi but do NOT send any
 *     decide call. A pending approval stays `unresolved` on the server by
 *     design (Req 6.7).
 *   - Assistant output is rendered as plain text via template interpolation
 *     (no `innerHTML`, no `lwc:dom="manual"`) so no XSS vector is opened.
 *
 * See requirements 1.1-1.3, 1.5, 2.3, 2.4, 3.6, 3.7, 4.1, 4.4, 4.5, 5.3-5.5,
 * 6.1-6.7, 7.1-7.5, 8.4, 9.1-9.3, 11.2, 12.3, 13.2.
 */
import { LightningElement, api, track, wire } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import { getRecord } from 'lightning/uiRecordApi';
import CURRENT_USER_ID from '@salesforce/user/Id';

import getClientConfig from '@salesforce/apex/ChatAgentController.getClientConfig';
import getRecordContext from '@salesforce/apex/ChatAgentController.getRecordContext';
import restoreTranscript from '@salesforce/apex/ChatAgentController.restoreTranscript';
import submitMessage from '@salesforce/apex/ChatAgentController.submitMessage';
import decideOperation from '@salesforce/apex/ChatAgentController.decideOperation';
import startNewSession from '@salesforce/apex/ChatAgentController.startNewSession';
import retryLastRequest from '@salesforce/apex/ChatAgentController.retryLastRequest';

const STREAM_CHANNEL = '/event/Chat_Stream_Event__e';
const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';
const ROLE_SYSTEM = 'system';

const EVENT_TYPE_CONNECTION_INTERRUPTED = 'connection_interrupted';
const EVENT_TYPE_ERROR = 'error';

// Catalog values accepted by the MCP `sendMessage` tool (see
// https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html).
const CATALOG_AWS = 'AWS';
const CATALOG_SANDBOX = 'Sandbox';

// Error codes that the server may return. Kept in sync with
// ChatAgentController's internal taxonomy so branching stays trivial.
const ERR_ACCESS_DENIED = 'ACCESS_DENIED';
const ERR_CONFIG_ERROR = 'CONFIG_ERROR';
const ERR_ATTACHMENT_INVALID = 'ATTACHMENT_INVALID';
const ERR_AUTH_ERROR = 'AUTH_ERROR';
const ERR_CLIENT_ERROR = 'CLIENT_ERROR';
const ERR_RETRYABLE = 'RETRYABLE';
const ERR_TIMEOUT = 'TIMEOUT';
const ERR_SESSION_EXPIRED = 'SESSION_EXPIRED';
const ERR_UNKNOWN = 'UNKNOWN';

export default class ChatAgent extends LightningElement {
    @api recordId;
    @api objectApiName;

    @track config;
    @track transcript = [];
    @track error;
    @track pendingFiles = [];

    inputText = '';
    recordName;
    partnerCentralOpportunityId;
    isLoading = false;
    isSending = false;

    // Catalog the next turn will target. Read-only indicator derived
    // from `ConfigDto.isSandbox` on connect; the user cannot override
    // it. The AWS Partner CRM Connector's `awsapn__Companion_App_Settings__c`
    // sandbox checkbox is the single source of truth — having a second
    // toggle in the chat creates drift and a whole class of
    // session-catalog mismatch bugs. The Apex layer resolves the
    // catalog via `ConfigProvider.isSandbox()` on every turn, so the
    // LWC doesn't even need to pass it.
    selectedCatalog = CATALOG_AWS;

    currentTranscriptEntryId;
    subscription;

    // Cache of the last submit call so Retry can resend it exactly (Req 9.4).
    lastSubmitPayload;

    // Fetch the record Name dynamically using the objectApiName-qualified
    // field reference. Failure is silent — we just show the record id.
    // `$effectiveRecordId` is a computed reactive getter that resolves to
    // a real 18-char id ONLY when one was passed; on the Home page (no
    // record context) it stays undefined and LWC short-circuits the
    // wire without invoking the underlying UI API call, which otherwise
    // throws a validation error and prevents the whole component from
    // mounting.
    @wire(getRecord, { recordId: '$effectiveRecordId', layoutTypes: ['Compact'] })
    wiredRecord({ data, error }) {
        if (error) {
            // Silently ignore — a failed Name lookup isn't worth blocking the
            // whole component for. The record-context banner just shows the
            // record id instead.
            return;
        }
        if (data) {
            const nameField = data.fields && data.fields.Name;
            if (nameField) {
                this.recordName = nameField.displayValue || nameField.value || null;
            }
        }
    }

    // Pulls the APN CRM unique identifier (and record Name as a fallback)
    // from the server so the banner shows the same identifier users see in
    // Partner Central. Returns {} when no record is attached or access is
    // denied. Wire is gated on both `effectiveRecordId` and
    // `effectiveObjectApiName` being non-null, so it never fires on the
    // Home / App / Utility Bar placements.
    @wire(getRecordContext, {
        recordId: '$effectiveRecordId',
        objectApiName: '$effectiveObjectApiName'
    })
    wiredRecordContext({ data, error }) {
        if (error || !data) {
            return;
        }
        if (data.partnerCentralOpportunityId) {
            this.partnerCentralOpportunityId = data.partnerCentralOpportunityId;
        }
        // `wiredRecord` (via UI API) is the primary source of the Name
        // field, but for org flavors where UI API is unavailable or the
        // object is managed-package-namespaced, fall back to the
        // controller's describe-based lookup.
        if (!this.recordName && data.recordName) {
            this.recordName = data.recordName;
        }
    }

    // Gated reactive params for the two wires. Returning `undefined`
    // (instead of an empty string) is what makes LWC skip the wire
    // invocation entirely. A truthy 15/18-char id is the only value
    // that should trigger the UI API callouts.
    get effectiveRecordId() {
        return this.recordId ? this.recordId : undefined;
    }
    get effectiveObjectApiName() {
        return this.recordId && this.objectApiName ? this.objectApiName : undefined;
    }

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------

    async connectedCallback() {
        this.isLoading = true;
        try {
            this.config = await getClientConfig();
            // Derive the read-only sandbox indicator from the server's
            // resolved value (`ConfigProvider.isSandbox()`, which
            // consults the AWS Partner CRM Connector's
            // `awsapn__PC_API_Sandbox_Enabled__c` flag). Users cannot
            // override this from the chat — the connector checkbox is
            // the canonical environment control for the org.
            if (this.config && this.config.isSandbox === true) {
                this.selectedCatalog = CATALOG_SANDBOX;
            } else {
                this.selectedCatalog = CATALOG_AWS;
            }
        } catch (e) {
            this.error = this.toClientError(e, 'Failed to load chat configuration.');
        }

        if (this.recordId) {
            try {
                const transcript = await restoreTranscript({ recordId: this.recordId });
                if (transcript && Array.isArray(transcript.entries)) {
                    this.transcript = transcript.entries.map((e) => this.hydrateEntry(e));
                }
            } catch (e) {
                // Empty transcript is the safe fallback; the user can still
                // start a new conversation.
                this.error = this.toClientError(e, 'Failed to restore prior transcript.');
            }
        }

        // Register an empApi error handler. It surfaces transport-level
        // issues (e.g. CometD disconnect) into the same error banner the
        // retry button is wired against (Req 4.5). BUT we only raise the
        // banner when a turn is actually in flight — CometD periodically
        // reconnects in the background (tab-focus changes, idle
        // timeouts, server-side session rotations) and those errors are
        // normal, auto-recovered, and orthogonal to our request. Since
        // TASK 7 we deliver the canonical turn output via the inline
        // events returned from `submitMessage`, so a CometD hiccup
        // during an idle period is not user-facing at all.
        onError((err) => {
            // Ignore transport errors when no turn is in flight and no
            // inline-event stream is expected to arrive.
            if (!this.isSending && !this.currentTranscriptEntryId) {
                return;
            }
            this.error = {
                code: ERR_RETRYABLE,
                message: 'Streaming connection interrupted. You can retry.',
                retryable: true,
                details: err ? JSON.stringify(err) : null
            };
        });

        this.isLoading = false;
    }

    disconnectedCallback() {
        // Unsubscribe from streaming. IMPORTANT: we explicitly do NOT send
        // any decide call for pending approvals here — the server-side
        // Pending_Write_Operation__c stays `unresolved` by design (Req 6.7).
        this.unsubscribeFromStream();
    }

    /**
     * Auto-scroll the transcript to the most recent message after every
     * render. We compare a running snapshot of the transcript length plus
     * the length of the in-flight assistant entry's text so we re-scroll
     * both when a new entry is appended AND when an existing streaming
     * entry grows. `requestAnimationFrame` keeps the scroll after the
     * DOM has flushed the new content.
     */
    renderedCallback() {
        const transcriptEl = this.template.querySelector('.chat-transcript');
        if (!transcriptEl) { return; }
        const signature = this.transcriptSignature();
        if (signature === this._lastTranscriptSignature) {
            return;
        }
        this._lastTranscriptSignature = signature;
        // Defer to the next frame so the DOM reflects the new entry
        // before we measure scrollHeight.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        window.requestAnimationFrame(() => {
            transcriptEl.scrollTop = transcriptEl.scrollHeight;
        });
    }

    transcriptSignature() {
        if (!Array.isArray(this.transcript)) { return '0'; }
        // Include both the count AND the text length of every entry so
        // incremental token arrivals trigger a fresh scroll.
        let total = this.transcript.length;
        for (const entry of this.transcript) {
            total += (entry.text ? entry.text.length : 0);
            if (entry.pendingApprovals) {
                total += entry.pendingApprovals.length;
            }
        }
        return String(total);
    }

    // -----------------------------------------------------------------
    // Derived state / template getters
    // -----------------------------------------------------------------

    get isUtilityBarMode() {
        return !this.recordId;
    }

    get showSandboxBadge() {
        return this.selectedCatalog === CATALOG_SANDBOX;
    }

    get acceptedMimeTypes() {
        if (!this.config || !Array.isArray(this.config.allowedMimeTypes)) {
            return '';
        }
        return this.config.allowedMimeTypes.join(',');
    }

    get hasTranscript() {
        return Array.isArray(this.transcript) && this.transcript.length > 0;
    }

    get hasPendingFiles() {
        return this.pendingFiles.length > 0;
    }

    get recordContextLabel() {
        if (this.isUtilityBarMode) {
            return '';
        }
        const parts = [];
        if (this.objectApiName) {
            // Strip managed-package namespace prefix and the `__c` suffix
            // so "awsapn__ACE_Opportunity__c" renders as "ACE Opportunity"
            // in the banner. The full API name is still sent to the
            // controller so the server-side lookup remains exact.
            const friendly = String(this.objectApiName)
                .replace(/^[a-zA-Z0-9]+__/, '')
                .replace(/__c$/, '')
                .replace(/_/g, ' ');
            parts.push(friendly);
        }
        // Prefer the APN CRM unique identifier over the Salesforce record
        // Name when available — partner sales users recognise the Partner
        // Central opportunity id (e.g. O13105594) as the canonical handle
        // for the record, and the agent itself uses that id upstream.
        if (this.partnerCentralOpportunityId) {
            parts.push(this.partnerCentralOpportunityId);
        } else if (this.recordName) {
            parts.push(this.recordName);
        }
        return parts.length ? parts.join(' · ') : this.recordId;
    }

    get isSendDisabled() {
        return this.isSending || this.isLoading
            || (!this.inputText || !this.inputText.trim().length)
            && !this.pendingFiles.length;
    }

    get showError() {
        return !!this.error;
    }

    get errorIsRetryable() {
        return !!(this.error && this.error.retryable);
    }

    get errorIsSessionExpired() {
        return !!(this.error && this.error.code === ERR_SESSION_EXPIRED);
    }

    // -----------------------------------------------------------------
    // Input handlers
    // -----------------------------------------------------------------

    handleInputChange(event) {
        this.inputText = event.target.value;
    }

    /**
     * Keyboard shortcut: Enter submits the message (if not disabled);
     * Shift+Enter inserts a newline as usual. Matches the behaviour of
     * most chat clients so users don't have to mouse over to the Send
     * button for every turn.
     */
    handleInputKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!this.isSendDisabled) {
                this.handleSubmit();
            }
        }
    }

    /**
     * File picker change handler. Performs client-side MIME / size checks
     * and base64-encodes any accepted file. Server also re-validates via
     * AttachmentValidator (Property 10) so this is defense-in-depth.
     */
    async handleFileChange(event) {
        const files = Array.from(event.target.files || []);
        const allowedTypes = (this.config && this.config.allowedMimeTypes) || [];
        const maxBytes = (this.config && this.config.maxAttachmentSizeBytes) || 0;
        const accepted = [];

        for (const file of files) {
            if (allowedTypes.length && !this.mimeAllowed(file.type, allowedTypes)) {
                this.error = {
                    code: ERR_ATTACHMENT_INVALID,
                    message: `Attachment "${file.name}" rejected: MIME type "${file.type}" is not in the allowed list.`,
                    retryable: false
                };
                continue;
            }
            if (maxBytes && file.size > maxBytes) {
                this.error = {
                    code: ERR_ATTACHMENT_INVALID,
                    message: `Attachment "${file.name}" rejected: size ${file.size} exceeds the ${maxBytes}-byte limit.`,
                    retryable: false
                };
                continue;
            }
            try {
                const base64 = await this.readFileAsBase64(file);
                accepted.push({
                    fileName: file.name,
                    mimeType: file.type,
                    sizeBytes: file.size,
                    base64Content: base64
                });
            } catch (e) {
                this.error = {
                    code: ERR_ATTACHMENT_INVALID,
                    message: `Attachment "${file.name}" rejected: failed to read file contents.`,
                    retryable: false
                };
            }
        }

        this.pendingFiles = [...this.pendingFiles, ...accepted];
        // Reset the input so selecting the same file again triggers a change.
        event.target.value = null;
    }

    handleRemovePendingFile(event) {
        const fileName = event.currentTarget.dataset.fileName;
        this.pendingFiles = this.pendingFiles.filter((f) => f.fileName !== fileName);
    }

    mimeAllowed(mimeType, allowedTypes) {
        if (!mimeType) {
            return false;
        }
        const lower = mimeType.toLowerCase();
        return allowedTypes.some((t) => (t || '').toLowerCase() === lower);
    }

    readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result || '';
                const comma = result.indexOf(',');
                resolve(comma >= 0 ? result.substring(comma + 1) : result);
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    // -----------------------------------------------------------------
    // Submit / retry
    // -----------------------------------------------------------------

    async handleSubmit() {
        if (this.isSending) {
            return;
        }
        const messageText = (this.inputText || '').trim();
        const attachments = this.pendingFiles;
        if (!messageText && !attachments.length) {
            return;
        }

        this.error = null;
        this.isSending = true;

        // Optimistically render the user's turn locally so they see it
        // immediately. The server-side persisted transcript will catch up
        // on the next restoreTranscript.
        const userEntry = {
            entryId: this.localId(),
            role: ROLE_USER,
            text: messageText,
            attachments: attachments.map((a) => ({
                fileName: a.fileName,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes
            })),
            pendingApprovals: [],
            isStreaming: false,
            isComplete: true
        };
        this.transcript = [...this.transcript, this.hydrateEntry(userEntry)];

        const payload = {
            recordId: this.recordId,
            objectApiName: this.objectApiName,
            messageText,
            attachments
            // Intentionally no `catalog` — the server-side
            // ConfigProvider.isSandbox() resolves it from the
            // connector's awsapn__PC_API_Sandbox_Enabled__c flag on
            // every turn, so there is a single source of truth for
            // the target environment.
        };
        this.lastSubmitPayload = payload;

        try {
            const result = await submitMessage(payload);
            this.handleSubmitResult(result);
        } catch (e) {
            this.error = this.toClientError(e, 'Failed to send message.');
            this.isSending = false;
        } finally {
            // Clear input regardless; the user's turn is already in the transcript.
            this.inputText = '';
            this.pendingFiles = [];
        }
    }

    handleSubmitResult(result) {
        if (!result || result.ok !== true) {
            this.error = this.fromServerResult(result);
            this.isSending = false;
            return;
        }
        // Create an empty streaming assistant entry that the stream callback
        // will progressively fill.
        this.currentTranscriptEntryId = result.transcriptEntryId;
        const assistantEntry = this.hydrateEntry({
            entryId: result.transcriptEntryId,
            role: ROLE_ASSISTANT,
            text: '',
            attachments: [],
            pendingApprovals: [],
            isStreaming: true,
            isComplete: false
        });
        this.transcript = [...this.transcript, assistantEntry];

        // Apply any events the controller returned inline. Apex
        // invokeStreaming both publishes to the CometD platform event bus
        // AND returns events on the synchronous response, because the LWC
        // subscribes after the Apex call returns and would otherwise miss
        // the published events. The inline delivery is the canonical path
        // for the turn's response; the CometD subscription remains for
        // out-of-band events (e.g. concurrent retries, fan-out).
        const inlineEvents = result.payload && Array.isArray(result.payload.events)
            ? result.payload.events
            : [];
        if (inlineEvents.length) {
            for (const e of inlineEvents) {
                this.applyInlineEvent(e);
            }
        }

        // Subscribe regardless so any out-of-band follow-on events are
        // still rendered. If the stream was fully resolved inline (all
        // terminal events applied, currentTranscriptEntryId cleared by
        // applyInlineEvent), the subscribe is effectively idle.
        this.subscribeToStream();
    }

    /**
     * Applies an inline event returned from submitMessage, mirroring the
     * logic in handleStreamEvent so a user never notices which transport
     * delivered the tokens.
     */
    applyInlineEvent(e) {
        if (!e || !e.transcriptEntryId) {
            return;
        }
        const entryId = e.transcriptEntryId;
        const eventType = e.eventType;
        const data = e.data;
        const isTerminal = e.isTerminal === true;

        if (eventType === EVENT_TYPE_CONNECTION_INTERRUPTED) {
            this.markEntryInterrupted(entryId);
            this.error = {
                code: ERR_RETRYABLE,
                message: 'Connection interrupted. Partial response preserved. You can retry.',
                retryable: true
            };
            this.isSending = false;
            return;
        }
        if (eventType === EVENT_TYPE_ERROR) {
            this.markEntryError(entryId, data);
            this.error = {
                code: ERR_UNKNOWN,
                message: data || 'Server reported an error.',
                retryable: false
            };
            if (isTerminal) {
                this.isSending = false;
            }
            return;
        }
        const approval = this.tryParseApproval(data);
        if (approval) {
            this.appendApproval(entryId, approval);
        } else if (data) {
            this.appendText(entryId, data);
        }
        if (isTerminal) {
            this.markEntryComplete(entryId);
            if (this.currentTranscriptEntryId === entryId) {
                this.currentTranscriptEntryId = null;
            }
            this.isSending = false;
        }
    }

    async handleRetry() {
        if (this.isSending) {
            return;
        }
        this.error = null;
        try {
            await retryLastRequest({ recordId: this.recordId });
        } catch (e) {
            // Fall through — we still try to resubmit below.
        }
        if (this.lastSubmitPayload) {
            this.isSending = true;
            try {
                const result = await submitMessage(this.lastSubmitPayload);
                this.handleSubmitResult(result);
            } catch (e) {
                this.error = this.toClientError(e, 'Retry failed.');
                this.isSending = false;
            }
        }
    }

    // -----------------------------------------------------------------
    // Stream subscription
    // -----------------------------------------------------------------

    subscribeToStream() {
        if (this.subscription) {
            // Reuse existing subscription — it is scoped by filter in the callback.
            return;
        }
        const callback = (response) => this.handleStreamEvent(response);
        subscribe(STREAM_CHANNEL, -1, callback)
            .then((sub) => {
                this.subscription = sub;
            })
            .catch(() => {
                // Streaming transport unavailable; surface a retryable error.
                this.error = {
                    code: ERR_RETRYABLE,
                    message: 'Unable to subscribe to the chat stream. You can retry.',
                    retryable: true
                };
                this.isSending = false;
            });
    }

    unsubscribeFromStream() {
        if (!this.subscription) {
            return;
        }
        try {
            unsubscribe(this.subscription, () => {});
        } catch (e) {
            // ignore — component may already be torn down
        }
        this.subscription = null;
    }

    handleStreamEvent(response) {
        const payload = response && response.data && response.data.payload;
        if (!payload) {
            return;
        }
        const userId = payload.User__c;
        const entryId = payload.Transcript_Entry_Id__c;
        // Filter: only process events for this user and the in-flight entry.
        if (userId !== CURRENT_USER_ID) {
            return;
        }
        if (!this.currentTranscriptEntryId || entryId !== this.currentTranscriptEntryId) {
            return;
        }

        const eventType = payload.Event_Type__c;
        const data = payload.Data__c;
        const isTerminal = payload.Is_Terminal__c === true;

        if (eventType === EVENT_TYPE_CONNECTION_INTERRUPTED) {
            this.markEntryInterrupted(entryId);
            this.error = {
                code: ERR_RETRYABLE,
                message: 'Connection interrupted. Partial response preserved. You can retry.',
                retryable: true
            };
            this.unsubscribeFromStream();
            this.isSending = false;
            return;
        }

        if (eventType === EVENT_TYPE_ERROR) {
            this.markEntryError(entryId, data);
            this.error = {
                code: ERR_UNKNOWN,
                message: data || 'Server reported an error during streaming.',
                retryable: false
            };
            if (isTerminal) {
                this.unsubscribeFromStream();
                this.isSending = false;
            }
            return;
        }

        // Try to interpret the data payload as an ApprovalPromptDto. The
        // server wraps approval prompts in JSON and places them in Data__c.
        const approval = this.tryParseApproval(data);
        if (approval) {
            this.appendApproval(entryId, approval);
        } else if (data) {
            this.appendText(entryId, data);
        }

        if (isTerminal) {
            this.markEntryComplete(entryId);
            this.unsubscribeFromStream();
            this.currentTranscriptEntryId = null;
            this.isSending = false;
        }
    }

    tryParseApproval(data) {
        if (!data || typeof data !== 'string') {
            return null;
        }
        const trimmed = data.trim();
        if (!trimmed.startsWith('{')) {
            return null;
        }
        try {
            const obj = JSON.parse(trimmed);
            if (obj && obj.operationId && obj.summary) {
                return {
                    operationId: obj.operationId,
                    operationName: obj.operationName || '',
                    targetResourceId: obj.targetResourceId || '',
                    summary: obj.summary,
                    fieldDiffMarkdown: obj.fieldDiffMarkdown || '',
                    paramsPayloadJson: obj.paramsPayloadJson || '',
                    status: obj.status || 'pending',
                    decision: obj.decision || 'unresolved',
                    isExpanded: false,
                    isDeciding: false,
                    outcome: null
                };
            }
        } catch (e) {
            // not JSON — treat as plain text
        }
        return null;
    }

    // -----------------------------------------------------------------
    // Transcript mutators
    // -----------------------------------------------------------------

    hydrateEntry(entry) {
        const safe = { ...entry };
        safe.attachments = Array.isArray(safe.attachments) ? safe.attachments : [];
        safe.pendingApprovals = Array.isArray(safe.pendingApprovals) ? safe.pendingApprovals : [];
        safe.isStreaming = !!safe.isStreaming;
        safe.isComplete = safe.isComplete === undefined ? true : !!safe.isComplete;
        safe.roleClass = this.roleClass(safe.role);
        safe.isUser = safe.role === ROLE_USER;
        safe.isAssistant = safe.role === ROLE_ASSISTANT;
        safe.isSystem = safe.role === ROLE_SYSTEM;
        safe.hasAttachments = safe.attachments.length > 0;
        safe.hasApprovals = safe.pendingApprovals.length > 0;
        return safe;
    }

    roleClass(role) {
        switch (role) {
            case ROLE_USER: return 'chat-entry chat-entry_user slds-box slds-m-vertical_x-small';
            case ROLE_ASSISTANT: return 'chat-entry chat-entry_assistant slds-box slds-m-vertical_x-small';
            case ROLE_SYSTEM: return 'chat-entry chat-entry_system slds-box slds-theme_shade slds-m-vertical_x-small';
            default: return 'chat-entry slds-box slds-m-vertical_x-small';
        }
    }

    appendText(entryId, data) {
        this.transcript = this.transcript.map((entry) => {
            if (entry.entryId !== entryId) {
                return entry;
            }
            const next = { ...entry };
            next.text = (next.text || '') + data;
            next.isStreaming = true;
            return this.hydrateEntry(next);
        });
    }

    appendApproval(entryId, approval) {
        this.transcript = this.transcript.map((entry) => {
            if (entry.entryId !== entryId) {
                return entry;
            }
            const next = { ...entry };
            next.pendingApprovals = [...(next.pendingApprovals || []), approval];
            return this.hydrateEntry(next);
        });
    }

    markEntryComplete(entryId) {
        this.transcript = this.transcript.map((entry) => {
            if (entry.entryId !== entryId) {
                return entry;
            }
            return this.hydrateEntry({ ...entry, isStreaming: false, isComplete: true });
        });
    }

    markEntryInterrupted(entryId) {
        this.transcript = this.transcript.map((entry) => {
            if (entry.entryId !== entryId) {
                return entry;
            }
            return this.hydrateEntry({
                ...entry,
                isStreaming: false,
                isComplete: false,
                interrupted: true
            });
        });
    }

    markEntryError(entryId, message) {
        this.transcript = this.transcript.map((entry) => {
            if (entry.entryId !== entryId) {
                return entry;
            }
            return this.hydrateEntry({
                ...entry,
                isStreaming: false,
                isComplete: true,
                errorMessage: message
            });
        });
    }

    // -----------------------------------------------------------------
    // Approval handlers
    // -----------------------------------------------------------------

    handleToggleApprovalDetails(event) {
        const operationId = event.currentTarget.dataset.operationId;
        this.updateApproval(operationId, (a) => ({ ...a, isExpanded: !a.isExpanded }));
    }

    async handleApprove(event) {
        const operationId = event.currentTarget.dataset.operationId;
        await this.decide(operationId, 'approved');
    }

    async handleReject(event) {
        const operationId = event.currentTarget.dataset.operationId;
        await this.decide(operationId, 'rejected');
    }

    async decide(operationId, decision) {
        // Disable both buttons while in-flight.
        this.updateApproval(operationId, (a) => ({ ...a, isDeciding: true }));
        try {
            const result = await decideOperation({
                operationId,
                decision
                // Intentionally no `catalog` — see submitMessage; the
                // server resolves from the connector's sandbox flag.
            });
            if (result && result.ok === true) {
                // Find the transcript entry this approval belongs to so we
                // can append the agent's follow-up events beneath it.
                let hostEntryId = null;
                for (const entry of this.transcript) {
                    if (entry.pendingApprovals
                        && entry.pendingApprovals.some((a) => a.operationId === operationId)) {
                        hostEntryId = entry.entryId;
                        break;
                    }
                }
                this.updateApproval(operationId, (a) => ({
                    ...a,
                    isDeciding: false,
                    decision,
                    status: decision === 'approved' ? 'sent' : 'cancelled',
                    outcome: decision === 'approved'
                        ? 'Approved and sent to server.'
                        : 'Rejected. No action was taken.'
                }));

                // Apply any follow-up events the server returned (the
                // agent's reply after the tool ran, including chained
                // approvals). Create a fresh assistant entry so the
                // follow-up is visually distinct from the approval card.
                const events = result.payload
                    && Array.isArray(result.payload.events)
                    ? result.payload.events : [];
                if (events.length && hostEntryId) {
                    const followupEntryId = this.localId();
                    this.transcript = [
                        ...this.transcript,
                        this.hydrateEntry({
                            entryId: followupEntryId,
                            role: ROLE_ASSISTANT,
                            text: '',
                            attachments: [],
                            pendingApprovals: [],
                            isStreaming: false,
                            isComplete: false
                        })
                    ];
                    for (const e of events) {
                        this.applyInlineEvent({
                            ...e,
                            transcriptEntryId: followupEntryId
                        });
                    }
                }
            } else {
                const msg = (result && result.errorMessage) || 'Decision failed.';
                this.updateApproval(operationId, (a) => ({
                    ...a,
                    isDeciding: false,
                    outcome: msg
                }));
                this.error = this.fromServerResult(result);
            }
        } catch (e) {
            this.updateApproval(operationId, (a) => ({
                ...a,
                isDeciding: false,
                outcome: 'Decision failed.'
            }));
            this.error = this.toClientError(e, 'Failed to submit approval decision.');
        }
    }

    updateApproval(operationId, mutator) {
        this.transcript = this.transcript.map((entry) => {
            if (!entry.pendingApprovals || !entry.pendingApprovals.length) {
                return entry;
            }
            let changed = false;
            const nextApprovals = entry.pendingApprovals.map((a) => {
                if (a.operationId === operationId) {
                    changed = true;
                    return mutator(a);
                }
                return a;
            });
            if (!changed) {
                return entry;
            }
            return this.hydrateEntry({ ...entry, pendingApprovals: nextApprovals });
        });
    }

    // -----------------------------------------------------------------
    // New conversation / errors
    // -----------------------------------------------------------------

    async handleStartNew() {
        this.unsubscribeFromStream();
        this.currentTranscriptEntryId = null;
        this.isSending = false;
        try {
            await startNewSession({ recordId: this.recordId });
        } catch (e) {
            this.error = this.toClientError(e, 'Failed to start a new conversation.');
        }
        this.transcript = [];
        this.error = null;
        this.lastSubmitPayload = null;
    }

    handleDismissError() {
        this.error = null;
    }

    /**
     * Maps a `ChatAgentResult` failure envelope to the local error shape used
     * by the template. Recognises session-expired, auth, retryable, and
     * generic classifications so the template can render the right control.
     */
    fromServerResult(result) {
        if (!result) {
            return {
                code: ERR_UNKNOWN,
                message: 'Unknown server error.',
                retryable: false
            };
        }
        const code = result.errorCode || ERR_UNKNOWN;
        const message = result.errorMessage || 'Server returned an error.';
        const retryable = code === ERR_RETRYABLE || code === ERR_TIMEOUT;

        let detail = null;
        if (code === ERR_AUTH_ERROR) {
            // Req 2.4: include Named Credential name and status code if the
            // server embedded them in the message. We surface the raw
            // message verbatim since the server is the source of truth.
            detail = message;
        }
        return { code, message, detail, retryable };
    }

    toClientError(e, fallback) {
        const message = (e && (e.body && e.body.message || e.message)) || fallback;
        return {
            code: ERR_UNKNOWN,
            message,
            retryable: false
        };
    }

    localId() {
        // Simple client-only id for optimistically-rendered user turns.
        return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }
}