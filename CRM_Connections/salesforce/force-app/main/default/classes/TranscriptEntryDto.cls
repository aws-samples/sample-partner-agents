/**
 * Feature: partner-central-chat-agent
 *
 * A single entry (turn) in the chat transcript.
 *
 * An entry may represent a user message, an assistant response, or a system
 * notice. Assistant entries can be streamed incrementally, so `isStreaming`
 * and `isComplete` are used by the LWC to distinguish "text is still arriving"
 * from "final state". `attachments` and `pendingApprovals` are eagerly
 * initialised to empty lists so the wire payload never carries nulls for
 * these collections (simpler consumer code on the LWC side).
 *
 * See requirements 1.3, 6.2, 13.2.
 */
public with sharing class TranscriptEntryDto {

    // Role values: who authored this entry.
    public static final String ROLE_USER = 'user';
    public static final String ROLE_ASSISTANT = 'assistant';
    public static final String ROLE_SYSTEM = 'system';

    @AuraEnabled public String entryId;
    @AuraEnabled public String role;    // 'user' | 'assistant' | 'system'
    @AuraEnabled public String text;
    @AuraEnabled public List<AttachmentRefDto> attachments;
    @AuraEnabled public List<ApprovalPromptDto> pendingApprovals;
    @AuraEnabled public DateTime createdAt;
    @AuraEnabled public Boolean isStreaming;
    @AuraEnabled public Boolean isComplete;

    /**
     * No-arg constructor. Initialises the two list fields so downstream
     * consumers (LWC, audit logger) can iterate without null checks.
     */
    public TranscriptEntryDto() {
        this.attachments = new List<AttachmentRefDto>();
        this.pendingApprovals = new List<ApprovalPromptDto>();
    }
}
