/**
 * Feature: partner-central-chat-agent
 *
 * Approval prompt DTO rendered inline in the transcript whenever the agent
 * requests a human decision before executing a write operation (Req 6.2, 7.5).
 *
 * `status` tracks the lifecycle of the prompt itself (pending -> sent /
 * cancelled), while `decision` records the user's response once resolved
 * (approved / rejected / unresolved). The two are kept separate so the
 * transcript can distinguish "still awaiting a click" from "we asked, the
 * user answered, and here is what they picked".
 *
 * See requirements 6.2, 7.5, 13.2.
 */
public with sharing class ApprovalPromptDto {

    // Status values: lifecycle of the prompt.
    public static final String STATUS_PENDING = 'pending';
    public static final String STATUS_SENT = 'sent';
    public static final String STATUS_CANCELLED = 'cancelled';

    // Decision values: user's resolution on the prompt.
    public static final String DECISION_APPROVED = 'approved';
    public static final String DECISION_REJECTED = 'rejected';
    public static final String DECISION_UNRESOLVED = 'unresolved';

    @AuraEnabled public String operationId;
    @AuraEnabled public String operationName;
    @AuraEnabled public String targetResourceId;
    @AuraEnabled public String summary;
    @AuraEnabled public String fieldDiffMarkdown;
    @AuraEnabled public String paramsPayloadJson;
    @AuraEnabled public String status;    // 'pending' | 'sent' | 'cancelled'
    @AuraEnabled public String decision;  // 'approved' | 'rejected' | 'unresolved'

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public ApprovalPromptDto() {}
}
