/**
 * Feature: partner-central-chat-agent
 *
 * Pure validator for user-uploaded `AttachmentDto` instances.
 *
 * Enforces the two rules described in Requirement 7:
 *   - MIME type must appear in the configured allow-list (case-insensitive).
 *   - `sizeBytes` must be &le; the configured maximum.
 *
 * The class is stateless (private constructor, only static methods) and has
 * no side effects so it can be invoked from the controller entry point
 * before any callout is made (Req 7.3: short-circuit on violation). All
 * outcomes are returned through `ValidationResult`; the validator never
 * throws on domain failures.
 *
 * See requirements 7.1, 7.2, 7.3.
 */
public with sharing class AttachmentValidator {

    /**
     * Per-image size ceiling enforced in addition to the configured
     * document ceiling. The AWS Partner Central MCP server rejects images
     * larger than 3.75 MB (documents may go up to 4.5 MB), so we enforce
     * the stricter image limit here to fail fast with a clear message
     * rather than after a wasted S3 upload. 3.75 * 1024 * 1024 bytes.
     */
    @TestVisible
    private static final Integer MAX_IMAGE_SIZE_BYTES = 3932160;

    /** Prevents instantiation — this class is a stateless utility. */
    private AttachmentValidator() {}

    /**
     * Validates a single `AttachmentDto` against the allowed MIME-type list
     * and the configured maximum size in bytes.
     *
     * Returns the first rule that is violated (in the order: null attachment,
     * missing MIME type, missing size, size exceeds max, MIME type not in
     * allow-list). Returns `ValidationResult.success()` if every rule passes.
     *
     * The MIME comparison is case-insensitive so a configured
     * `application/pdf` matches a user-submitted `Application/PDF`.
     */
    public static ValidationResult validate(AttachmentDto att, List<String> allowedMimeTypes, Integer maxSizeBytes) {
        if (att == null) {
            return ValidationResult.failure(
                ValidationResult.RULE_NULL_ATTACHMENT,
                'Attachment is null.'
            );
        }
        if (String.isBlank(att.mimeType)) {
            return ValidationResult.failure(
                ValidationResult.RULE_MISSING_MIME_TYPE,
                'Attachment "' + String.valueOf(att.fileName) + '" has no MIME type.'
            );
        }
        if (att.sizeBytes == null) {
            return ValidationResult.failure(
                ValidationResult.RULE_MISSING_SIZE,
                'Attachment "' + att.fileName + '" has no declared size.'
            );
        }
        // Size rule first so the most common failure mode reports clearly.
        if (maxSizeBytes != null && att.sizeBytes > maxSizeBytes) {
            return ValidationResult.failure(
                ValidationResult.RULE_SIZE,
                'Attachment "' + att.fileName + '" is ' + att.sizeBytes
                    + ' bytes, which exceeds the configured maximum of '
                    + maxSizeBytes + ' bytes.'
            );
        }
        // Stricter ceiling for images (3.75 MB) per the MCP server's
        // documented limits, applied on top of the configured document max.
        if (att.mimeType.toLowerCase().startsWith('image/')
            && att.sizeBytes > MAX_IMAGE_SIZE_BYTES) {
            return ValidationResult.failure(
                ValidationResult.RULE_SIZE,
                'Image "' + att.fileName + '" is ' + att.sizeBytes
                    + ' bytes, which exceeds the image maximum of '
                    + MAX_IMAGE_SIZE_BYTES + ' bytes (3.75 MB).'
            );
        }
        // MIME allow-list (case-insensitive).
        Boolean mimeAllowed = false;
        if (allowedMimeTypes != null) {
            String lowerMime = att.mimeType.toLowerCase();
            for (String allowed : allowedMimeTypes) {
                if (allowed != null && allowed.toLowerCase() == lowerMime) {
                    mimeAllowed = true;
                    break;
                }
            }
        }
        if (!mimeAllowed) {
            return ValidationResult.failure(
                ValidationResult.RULE_MIME_TYPE,
                'Attachment "' + att.fileName + '" has MIME type "' + att.mimeType
                    + '" which is not in the allowed list.'
            );
        }
        return ValidationResult.success();
    }

    /**
     * Convenience that validates a list of attachments and returns the first
     * failure (so the caller can surface exactly one error to the user).
     * A null or empty list is treated as success — callers requiring at
     * least one attachment enforce that separately.
     */
    public static ValidationResult validateAll(List<AttachmentDto> attachments, List<String> allowedMimeTypes, Integer maxSizeBytes) {
        if (attachments == null || attachments.isEmpty()) {
            return ValidationResult.success();
        }
        for (AttachmentDto att : attachments) {
            ValidationResult r = validate(att, allowedMimeTypes, maxSizeBytes);
            if (!r.ok) {
                return r;
            }
        }
        return ValidationResult.success();
    }
}
