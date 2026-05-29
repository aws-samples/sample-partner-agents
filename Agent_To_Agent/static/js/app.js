let selectedDealId = null;
let currentSessionId = null;
let currentToolUseId = null;
let chatSessionId = null;
let lastGeneratedNextSteps = '';

function showTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[onclick="showTab('${tab}')"]`).classList.add('active');
    document.getElementById(`${tab}-panel`).classList.add('active');
}

// --------------------------------------------------------------------
// CRM registry — all CRM metadata is fetched from /api/crm/specs on
// load. Nothing about specific CRMs is hardcoded on the frontend.
// --------------------------------------------------------------------
let _crmSpecs = [];     // array of CrmSpec dicts
let _crmSpecById = {};  // id -> spec

function _getCurrentCrmSpec() {
    const id = document.getElementById('crm-type').value;
    return _crmSpecById[id];
}

async function initCrmRegistry() {
    try {
        const resp = await fetch('/api/crm/specs');
        const data = await resp.json();
        _crmSpecs = data.crms || [];
        _crmSpecById = {};
        _crmSpecs.forEach(s => { _crmSpecById[s.id] = s; });

        // Populate the dropdown from the registry
        const sel = document.getElementById('crm-type');
        sel.innerHTML = '';
        _crmSpecs.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.display_name;
            sel.appendChild(opt);
        });

        updateCrmUI();
    } catch (err) {
        console.error('Failed to load CRM specs:', err);
    }
}

function updateCrmUI() {
    const spec = _getCurrentCrmSpec();
    if (!spec) return;

    const loadBtn = document.getElementById('load-crm-btn');
    const loadingText = document.getElementById('loading-text');
    const tokenLabel = document.getElementById('crm-token-label');
    const tokenInput = document.getElementById('crm-token');
    const instanceRow = document.getElementById('crm-instance-row');
    const instanceLabel = document.getElementById('crm-instance-label');
    const instanceInput = document.getElementById('crm-instance-url');

    loadBtn.textContent = spec.load_button_label;
    loadingText.textContent = `Loading records from ${spec.display_name}...`;
    if (tokenLabel) tokenLabel.textContent = spec.token_label;
    if (tokenInput) tokenInput.placeholder = spec.token_placeholder;

    if (spec.instance_url_label) {
        instanceRow.style.display = 'flex';
        instanceLabel.textContent = spec.instance_url_label;
        instanceInput.placeholder = spec.instance_url_placeholder || '';
    } else {
        instanceRow.style.display = 'none';
        instanceInput.value = '';
    }
}

// Kick off the registry fetch on load
window.addEventListener('DOMContentLoaded', initCrmRegistry);

async function loadCrmRecords() {
    const spec = _getCurrentCrmSpec();
    if (!spec) { alert('CRM registry not loaded'); return; }

    const token = document.getElementById('crm-token').value.trim();
    const instanceUrl = document.getElementById('crm-instance-url').value.trim();

    if (!token) {
        alert(`Please enter your ${spec.token_label.toLowerCase()}`);
        return;
    }
    if (spec.instance_url_label && !instanceUrl) {
        alert(`Please enter your ${spec.instance_url_label}`);
        return;
    }

    document.getElementById('deals-loading').style.display = 'block';
    document.getElementById('deals-list').innerHTML = '';

    try {
        const response = await fetch('/api/crm/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, crm_type: spec.id, instance_url: instanceUrl })
        });
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        const dealsList = document.getElementById('deals-list');
        data.records.forEach(record => {
            const card = document.createElement('div');
            card.className = 'deal-card';
            card.onclick = () => selectDeal(record.id, card);
            const safeName = (record.name || '').replace(/'/g, "\'");
            const nextStepHtml = record.next_step
                ? `<div class="deal-next-step" style="margin-top: 4px; font-size: 12px; color: #aaa;"><strong>Next Step:</strong> ${escapeHtml(record.next_step)}</div>`
                : '';
            card.innerHTML = `
                <div class="deal-name">${record.name}</div>
                <div class="deal-info">
                    <span class="deal-amount">$${Number(record.amount || 0).toLocaleString()}</span>
                    &nbsp;•&nbsp; ID: ${record.id}
                    &nbsp;•&nbsp; Close: ${record.close_date ? record.close_date.split('T')[0] : 'N/A'}
                </div>
                ${nextStepHtml}
                <span class="see-details-link" onclick="event.stopPropagation(); showRecordDetails('${record.id}', '${safeName}')">
                    🔍 See details
                </span>
            `;
            dealsList.appendChild(card);
        });

    } catch (error) {
        showResult('crm-result', false, error.message);
    } finally {
        document.getElementById('deals-loading').style.display = 'none';
    }
}

function selectDeal(dealId, card) {
    document.querySelectorAll('.deal-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedDealId = dealId;
    document.getElementById('create-section').style.display = 'block';
}

// Escape untrusted strings before inserting into innerHTML to prevent XSS.
function escapeHtml(value) {
    if (value === null || value === undefined || value === '') return '';
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
}

function renderField(label, value) {
    const isEmpty = value === null || value === undefined || value === '';
    const displayValue = isEmpty ? '—' : escapeHtml(value);
    const emptyClass = isEmpty ? ' empty' : '';
    return `
        <div class="modal-field">
            <span class="modal-field-label">${escapeHtml(label)}</span>
            <span class="modal-field-value${emptyClass}">${displayValue}</span>
        </div>
    `;
}

function renderModalSection(title, fields) {
    const fieldsHtml = fields.map(f => renderField(f[0], f[1])).join('');
    return `
        <div class="modal-section">
            <h4>${escapeHtml(title)}</h4>
            ${fieldsHtml}
        </div>
    `;
}

async function showRecordDetails(recordId, recordName) {
    const spec = _getCurrentCrmSpec();
    if (!spec) { alert('CRM registry not loaded'); return; }

    const token = document.getElementById('crm-token').value;
    const instanceUrl = document.getElementById('crm-instance-url').value;

    // Show modal with loading state
    const modal = document.getElementById('details-modal');
    const titleEl = document.getElementById('modal-title');
    const subtitleEl = document.getElementById('modal-subtitle');
    const bodyEl = document.getElementById('modal-body');

    titleEl.textContent = recordName || 'Record Details';
    subtitleEl.textContent = `${spec.display_name} • ${recordId}`;
    bodyEl.innerHTML = `
        <div class="loading" style="display: block;">
            <div class="spinner"></div>
            <p>Loading details from ${escapeHtml(spec.display_name)}...</p>
        </div>
    `;
    modal.classList.add('active');

    try {
        const response = await fetch('/api/crm/record-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, record_id: recordId, crm_type: spec.id, instance_url: instanceUrl })
        });
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        const d = data.details;
        let html = '';
        
        // Opportunity / Deal overview
        const overviewFields = [
            ['ID', d.id],
            ['Name', d.name],
            ['Stage', d.stage],
            ['Amount', d.amount ? '$' + Number(d.amount).toLocaleString() : ''],
            ['Close Date', d.close_date ? d.close_date.split('T')[0] : '']
        ];
        html += renderModalSection(spec.display_name + ' Record', overviewFields);
        
        // Description (only if present)
        if (d.description) {
            html += renderModalSection('Description', [['', d.description]]);
        }
        
        // Account (Salesforce)
        if (d.account) {
            html += renderModalSection('Account', [
                ['Company', d.account.name],
                ['Industry', d.account.industry]
            ]);
        }
        
        // Contact
        if (d.contact) {
            html += renderModalSection('Primary Contact', [
                ['Name', d.contact.name],
                ['Title', d.contact.title],
                ['Email', d.contact.email],
                ['Phone', d.contact.phone]
            ]);
        }
        
        // Address (Salesforce)
        if (d.address) {
            html += renderModalSection('Billing Address', [
                ['Street', d.address.street],
                ['City', d.address.city],
                ['State', d.address.state],
                ['Postal Code', d.address.postal_code],
                ['Country', d.address.country]
            ]);
        }
        
        // Partner Central / ACE sync indicator (HubSpot)
        // We focus on the built-in "Next Step" field which is what
        // bidirectional sync writes by default. Custom ACE fields
        // are shown only if a participant has configured them.
        if (d.partner_central) {
            const pc = d.partner_central;
            const recordId = d.id;
            
            // Primary: Next Step (built-in field, populated by sync)
            const primaryFields = [
                ['Next Step (synced from ACE)', pc.next_step || '(not synced yet)']
            ];
            html += renderModalSection('Partner Central Sync', primaryFields);
            
            // Optional: ACE custom fields (only shown if any are populated)
            const advancedFields = [
                ['ACE Opportunity ID', pc.opportunity_id],
                ['Sync Status', pc.sync_status],
                ['ACE Stage', pc.ace_stage],
                ['ACE Validation Status', pc.ace_validation_status]
            ].filter(f => f[1]);  // Only show fields with values
            
            if (advancedFields.length > 0) {
                html += renderModalSection('ACE Custom Fields (optional)', advancedFields);
            }
            
            // Demo action buttons for HubSpot deals only
            if (data.crm_type === 'hubspot' || (d.crm_type === 'hubspot')) {
                const aceId = pc.opportunity_id || '';
                html += `
                    <div style="margin-top: 20px; padding: 15px; background: rgba(0,212,255,0.05); border: 1px solid rgba(0,212,255,0.3); border-radius: 8px;">
                        <h4 style="margin-bottom: 12px; color: #00d4ff;">🎬 Demo Actions</h4>
                        <p style="font-size: 13px; color: #aaa; margin-bottom: 12px;">
                            Sync the latest ACE opportunity status to this HubSpot deal's <strong>Next Step</strong> field, or reset for a clean demo run.
                        </p>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
                            <button class="btn btn-primary" onclick="syncFromAcePrompt('${recordId}', '${aceId}')">🔄 Sync from ACE</button>
                            <button class="btn btn-secondary" onclick="resetDealFields('${recordId}')">🧹 Reset Demo</button>
                        </div>
                        <div id="modal-action-result" style="margin-top: 12px;"></div>
                    </div>
                `;
            }
        }
        
        bodyEl.innerHTML = html;
        
    } catch (error) {
        bodyEl.innerHTML = `
            <div class="result error" style="display: block;">
                <pre>Failed to load details: ${escapeHtml(error.message)}</pre>
            </div>
        `;
    }
}

function closeDetailsModal() {
    document.getElementById('details-modal').classList.remove('active');
}

async function syncFromAcePrompt(recordId, existingAceId) {
    // Resolution priority:
    // 1. Custom CRM field (partner_central_opportunity_id) — if configured
    // 2. In-memory session cache — set when create-opportunity is called
    // 3. Manual prompt — fallback for new sessions / page refresh
    let aceId = existingAceId;
    const spec = _getCurrentCrmSpec();
    
    if (!aceId) {
        // Try the session cache via API
        try {
            const cacheResp = await fetch('/api/crm/get-ace-mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ record_id: recordId, crm_type: spec.id })
            });
            const cacheData = await cacheResp.json();
            if (cacheData.found && cacheData.ace_opportunity_id) {
                aceId = cacheData.ace_opportunity_id;
            }
        } catch (e) {
            console.warn('Cache lookup failed:', e);
        }
    }
    
    if (!aceId) {
        aceId = prompt(
            "Enter the ACE Opportunity ID to sync from (e.g., O12345678):\n\n" +
            "Tip: After creating an ACE opportunity from this deal in this session, " +
            "the ID is auto-detected. This prompt only appears for deals that have " +
            "no ACE opportunity created in the current session.",
            document.getElementById('opp-id').value || ''
        );
        if (!aceId) return;
        aceId = aceId.trim();
    }
    return syncFromAce(recordId, aceId);
}

async function syncFromAce(recordId, opportunityId) {
    const token = document.getElementById('crm-token').value;
    const spec = _getCurrentCrmSpec();
    const resultEl = document.getElementById('modal-action-result');
    
    // Get the deal name for the confirmation message
    const dealName = document.getElementById('modal-title').textContent || `record ${recordId}`;
    
    // ⚠️ PRODUCTION CRM SAFETY: This writes to the user's live CRM.
    // Show a clear confirmation before any write so participants know
    // exactly what will be modified.
    const confirmMsg =
        `⚠️ This will modify the deal "${dealName}" in your live ${spec.display_name} account.\n\n` +
        `Field that will be updated from ACE Opportunity ${opportunityId}:\n` +
        `  • Next Step\n\n` +
        `(Other fields like Stage, Amount, Close Date are intentionally not synced — they vary across HubSpot pipelines and would risk 400 errors.)\n\n` +
        `Recommended: use a test deal (e.g., named "[TEST]") or a free HubSpot trial account.\n\n` +
        `Continue?`;
    if (!confirm(confirmMsg)) {
        return;
    }
    
    resultEl.innerHTML = '<div style="color: #00d4ff;">⏳ Syncing from ACE to ' + spec.display_name + '...</div>';
    
    try {
        const response = await fetch('/api/crm/sync-from-ace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                record_id: recordId,
                opportunity_id: opportunityId,
                token: token,
                crm_type: spec.id
            })
        });
        const data = await response.json();
        
        if (data.success) {
            const sync = data.sync_status || {};
            resultEl.innerHTML = `
                <div style="color: #00ff88; padding: 12px; background: rgba(0,255,136,0.1); border-radius: 6px;">
                    ✅ <strong>Synced!</strong><br>
                    ACE Stage: ${sync.stage || 'N/A'}<br>
                    ACE Validation Status: ${sync.review_status || 'N/A'}<br>
                    <em style="font-size: 12px;">Refresh the deal details to see the updated Next Step field.</em>
                    <br><button class="btn btn-secondary" onclick="showRecordDetails('${recordId}')" style="margin-top: 8px;">🔄 Refresh Details</button>
                </div>
            `;
        } else {
            resultEl.innerHTML = `<div style="color: #ff4444;">❌ Sync failed: ${data.error || 'Unknown error'}</div>`;
        }
    } catch (error) {
        resultEl.innerHTML = `<div style="color: #ff4444;">❌ Error: ${error.message}</div>`;
    }
}

async function resetDealFields(recordId) {
    const spec = _getCurrentCrmSpec();
    const dealName = document.getElementById('modal-title').textContent || `record ${recordId}`;
    
    // ⚠️ PRODUCTION CRM SAFETY: Confirm before clearing the Next Step
    // field on the user's live CRM.
    const confirmMsg =
        `⚠️ This will clear the Next Step field on the deal "${dealName}" in your live ${spec.display_name} account.\n\n` +
        `The ACE opportunity in Partner Central will NOT be deleted — only the Next Step text on the ${spec.display_name} deal will be cleared.\n\n` +
        `Recommended: only run Reset on a test deal you don't mind clearing.\n\n` +
        `Continue?`;
    if (!confirm(confirmMsg)) {
        return;
    }
    
    const token = document.getElementById('crm-token').value;
    const resultEl = document.getElementById('modal-action-result');
    
    resultEl.innerHTML = '<div style="color: #00d4ff;">⏳ Resetting Next Step field on ' + spec.display_name + ' deal...</div>';
    
    try {
        const response = await fetch('/api/crm/reset-deal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                record_id: recordId,
                token: token,
                crm_type: spec.id
            })
        });
        const data = await response.json();
        
        if (data.success) {
            resultEl.innerHTML = `
                <div style="color: #00ff88; padding: 12px; background: rgba(0,255,136,0.1); border-radius: 6px;">
                    ✅ <strong>Reset complete!</strong><br>
                    ${data.message || ''}
                    <br><button class="btn btn-secondary" onclick="showRecordDetails('${recordId}')" style="margin-top: 8px;">🔄 Refresh Details</button>
                </div>
            `;
        } else {
            resultEl.innerHTML = `<div style="color: #ff4444;">❌ Reset failed: ${data.error || 'Unknown error'}</div>`;
        }
    } catch (error) {
        resultEl.innerHTML = `<div style="color: #ff4444;">❌ Error: ${error.message}</div>`;
    }
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetailsModal();
});

async function createOpportunity() {
    if (!selectedDealId) {
        alert('Please select a record first');
        return;
    }
    
    const token = document.getElementById('crm-token').value;
    const instanceUrl = document.getElementById('crm-instance-url').value;
    const spec = _getCurrentCrmSpec();
    if (!spec) { alert('CRM registry not loaded'); return; }
    
    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Creating...';
    
    updateStep(2);
    
    try {
        const response = await fetch('/api/crm/create-opportunity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, record_id: selectedDealId, crm_type: spec.id, instance_url: instanceUrl })
        });
        const data = await response.json();
        
        if (data.success) {
            updateStep(3);
            showResult('crm-result', true, 
                `✅ ACE Opportunity Created!\n\n` +
                `Opportunity ID: ${data.ace_opportunity_id}\n` +
                `${spec.display_name} ${spec.record_label}: ${data.record_name}\n` +
                `Amount: $${Number(data.record_amount || 0).toLocaleString()}`
            );
            
            // Auto-fill the opportunity ID in update tab and chat tab
            document.getElementById('opp-id').value = data.ace_opportunity_id;
            document.getElementById('chat-opp-id').value = data.ace_opportunity_id;
        } else {
            throw new Error(data.error);
        }
        
    } catch (error) {
        showResult('crm-result', false, error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Create ACE Opportunity (Direct API)';
    }
}

// ----------------------------------------------------------------
// Create via Partner Central Agent (from CRM deal)
// ----------------------------------------------------------------
let createAgentSessionId = null;
let createAgentPendingApproval = null;
let createAgentRecordId = null;
let createAgentInitialPrompt = null;

// Simple markdown-to-HTML formatter for agent responses.
// Handles **bold**, `code`, line breaks, numbered/bullet lists.
function formatAgentMarkdown(text) {
    if (!text) return '';
    
    // Escape HTML first
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // Detect and highlight enrichment moments — when the agent mentions
    // looking up information from public sources, fill that part with a
    // glowing "✨ Enriched" indicator so partners notice the wow moment.
    const enrichmentPatterns = [
        /I (?:found|looked up|searched for|enriched|gathered) [^.!?\n]+(?:online|publicly|from public sources|from the web)?\b[^.!?\n]*/gi,
        /Based on (?:publicly available|public) (?:data|information|sources)[^.!?\n]*/gi,
        /(?:I'?ve? )?enriched (?:the|with|customer)[^.!?\n]*/gi,
        /(?:Found|Discovered|Identified)(?: the| their)? (?:website|industry|address|company info)[^.!?\n]*/gi,
    ];
    for (const pattern of enrichmentPatterns) {
        html = html.replace(pattern, (match) => {
            return `<span style="background: linear-gradient(90deg, rgba(0,255,136,0.15), rgba(0,212,255,0.15)); border-left: 3px solid #00ff88; padding: 4px 8px; border-radius: 3px; display: inline-block; margin: 2px 0;">✨ ${match}</span>`;
        });
    }
    
    // Bold: **text** -> <strong>text</strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic: *text* -> <em>text</em> (but not after a digit followed by . — that's a list)
    html = html.replace(/(?<!\d\.)\*([^*\n]+)\*/g, '<em>$1</em>');
    
    // Inline code: `text` -> <code>text</code>
    html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(0,212,255,0.15); padding: 2px 6px; border-radius: 3px; font-family: monospace;">$1</code>');
    
    // Split into lines for list/paragraph handling
    const lines = html.split('\n');
    const result = [];
    let inOrderedList = false;
    let inUnorderedList = false;
    
    for (let line of lines) {
        const trimmed = line.trim();
        
        // Numbered list: "1. item", "2. item" — match any digit
        // sequence so we handle the agent's quirk where it sometimes
        // sends "1. ... 1. ... 1." for what should be 1, 2, 3.
        if (/^\d+\.\s/.test(trimmed)) {
            if (!inOrderedList) {
                if (inUnorderedList) { result.push('</ul>'); inUnorderedList = false; }
                result.push('<ol style="margin: 8px 0 8px 20px; padding-left: 10px;">');
                inOrderedList = true;
            }
            result.push('<li style="margin-bottom: 6px;">' + trimmed.replace(/^\d+\.\s/, '') + '</li>');
        }
        // Bullet list: "- item" or "* item"
        else if (/^[-*]\s/.test(trimmed)) {
            if (!inUnorderedList) {
                if (inOrderedList) { result.push('</ol>'); inOrderedList = false; }
                result.push('<ul style="margin: 8px 0 8px 20px; padding-left: 10px;">');
                inUnorderedList = true;
            }
            result.push('<li style="margin-bottom: 6px;">' + trimmed.replace(/^[-*]\s/, '') + '</li>');
        }
        else if (trimmed === '') {
            // Blank line: keep current list open across the blank.
            // This way "1. foo\n\n1. bar\n\n1. baz" becomes one
            // <ol> with three sequential items, not three <ol>s each
            // starting at 1. The browser renumbers automatically.
            continue;
        }
        else {
            if (inOrderedList) { result.push('</ol>'); inOrderedList = false; }
            if (inUnorderedList) { result.push('</ul>'); inUnorderedList = false; }
            if (trimmed) {
                result.push('<p style="margin: 8px 0;">' + line + '</p>');
            }
        }
    }
    if (inOrderedList) result.push('</ol>');
    if (inUnorderedList) result.push('</ul>');
    
    return result.join('');
}

function addCreateAgentMessage(role, content) {
    const container = document.getElementById('create-agent-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.style.padding = '10px';
    msgDiv.style.marginBottom = '10px';
    msgDiv.style.borderRadius = '6px';
    msgDiv.style.background = role === 'user' ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.05)';
    
    // Format assistant messages as markdown; user messages and HTML (like approval boxes) pass through.
    const looksLikeHtml = /<\/?(div|button|p|strong|em|code|ul|ol|li|pre|br)\b/i.test(content);
    const formattedContent = (role === 'assistant' && !looksLikeHtml) ? formatAgentMarkdown(content) : content;
    
    msgDiv.innerHTML = `<strong>${role === 'user' ? 'You' : '🤖 Partner Central Agent'}:</strong>${formattedContent}`;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

async function openCreateViaAgentModal() {
    if (!selectedDealId) {
        alert('Please select a record first');
        return;
    }
    
    const token = document.getElementById('crm-token').value;
    const instanceUrl = document.getElementById('crm-instance-url').value;
    const spec = _getCurrentCrmSpec();
    
    // Reset state
    createAgentSessionId = null;
    createAgentPendingApproval = null;
    createAgentRecordId = selectedDealId;
    
    // Show modal
    document.getElementById('create-agent-subtitle').textContent = `From ${spec.display_name} ${spec.record_label} ${selectedDealId}`;
    document.getElementById('create-agent-messages').innerHTML = '';
    document.getElementById('create-agent-modal').classList.add('active');
    document.getElementById('create-agent-loading').style.display = 'block';
    
    // Fetch deal details to build the initial prompt
    try {
        const detailsResponse = await fetch('/api/crm/record-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, record_id: selectedDealId, crm_type: spec.id, instance_url: instanceUrl })
        });
        const detailsData = await detailsResponse.json();
        
        if (detailsData.error) {
            addCreateAgentMessage('assistant', `❌ Could not fetch deal details: ${detailsData.error}`);
            document.getElementById('create-agent-loading').style.display = 'none';
            return;
        }
        
        const d = detailsData.details;
        
        // Build initial prompt from deal data
        let prompt = `Create an opportunity from this ${spec.display_name} ${spec.record_label.toLowerCase()}:\n\n`;
        prompt += `Deal Name: ${d.name || 'N/A'}\n`;
        if (d.amount) prompt += `Amount: $${Number(d.amount).toLocaleString()}\n`;
        if (d.stage) prompt += `Current Stage: ${d.stage}\n`;
        if (d.close_date) prompt += `Target Close Date: ${d.close_date.split('T')[0]}\n`;
        if (d.description) prompt += `Description: ${d.description}\n`;
        
        if (d.contact && d.contact.name) {
            prompt += `\nContact: ${d.contact.name}`;
            if (d.contact.title) prompt += ` (${d.contact.title})`;
            if (d.contact.email) prompt += ` - ${d.contact.email}`;
            if (d.contact.phone) prompt += ` - ${d.contact.phone}`;
        }
        
        if (d.account && d.account.name) {
            prompt += `\nCompany: ${d.account.name}`;
            if (d.account.industry) prompt += ` (${d.account.industry})`;
        }
        
        if (d.address) {
            const addr = [d.address.street, d.address.city, d.address.state, d.address.postal_code, d.address.country].filter(x => x).join(', ');
            if (addr) prompt += `\nAddress: ${addr}`;
        }
        
        createAgentInitialPrompt = prompt;
        
        // Tell the agent whether to submit to AWS after creating. Default
        // is create-only so the user can verify the opportunity in
        // Partner Central before AWS review starts.
        const submitToAws = document.getElementById('create-agent-submit-to-aws')?.checked;
        if (submitToAws) {
            prompt += `\n\nIMPORTANT: After creating the opportunity, submit it to AWS for review. Confirm with me before submission.`;
        } else {
            prompt += `\n\nIMPORTANT: Create the opportunity only — do NOT submit it to AWS for review. Leave it in "Pending Submission" status so I can review it in Partner Central first. Stop after the opportunity is successfully created.`;
        }
        
        addCreateAgentMessage('user', `<em>Sending deal data to agent...</em><br><pre style="font-size: 11px; margin-top: 8px; white-space: pre-wrap;">${prompt}</pre>`);
        
        // Send to agent (reuse the create-from-notes endpoint)
        await sendToCreateAgent(prompt);
        
    } catch (error) {
        addCreateAgentMessage('assistant', `❌ Error: ${error.message}`);
        document.getElementById('create-agent-loading').style.display = 'none';
    }
}

async function sendToCreateAgent(message) {
    document.getElementById('create-agent-loading').style.display = 'block';
    
    try {
        // CRM tab: read the "Submit to AWS" checkbox so the backend
        // knows whether to allow the submit tool through.
        const allowSubmit = document.getElementById('create-agent-submit-to-aws')?.checked || false;
        const response = await fetch('/api/create-from-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                notes: message,
                session_id: createAgentSessionId,
                allow_submit: allowSubmit
            })
        });
        const data = await response.json();
        document.getElementById('create-agent-loading').style.display = 'none';
        
        if (data.error) {
            addCreateAgentMessage('assistant', `❌ Error: ${data.error}`);
        } else if (data.requires_approval) {
            createAgentSessionId = data.session_id;
            createAgentPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id
            };
            const approvalHtml = `
                ${data.answer || ''}
                <div style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 10px;">
                    <p><strong>🔐 Approval Required</strong></p>
                    <p>Tool: <code>${data.tool_name}</code></p>
                    <div style="margin-top: 10px;">
                        <button onclick="sendCreateAgentApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve & Create</button>
                        <button onclick="sendCreateAgentApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addCreateAgentMessage('assistant', approvalHtml);
        } else {
            createAgentSessionId = data.session_id;
            addCreateAgentMessage('assistant', data.answer);
            
            // "API + Agent" pattern: if the agent asked about a solution
            // or a private offer, fetch the deterministic list and render
            // clickable chips for the user to pick from.
            if (agentIsAskingForSolution(data.answer)) {
                await renderSolutionPicker();
            }
            if (agentIsAskingForOffer(data.answer)) {
                await renderOfferPicker();
            }
            
            // Check if opportunity was created
            const oppMatch = data.answer.match(/O\d{8,}/);
            if (oppMatch) {
                await onCreateAgentSuccess(oppMatch[0]);
            }
        }
    } catch (error) {
        document.getElementById('create-agent-loading').style.display = 'none';
        addCreateAgentMessage('assistant', `❌ Error: ${error.message}`);
    }
}

function agentIsAskingForSolution(answer) {
    if (!answer) return false;
    const text = answer.toLowerCase();
    // Detect when the Partner Central Agent asks for a solution. We
    // match a few common phrasings rather than a single keyword so the
    // picker shows up reliably across agent response variations.
    return (
        text.includes('partner solution id') ||
        text.includes('solution id like') ||
        /what solution (are you offering|do you|will you)/i.test(answer) ||
        /which (of your |registered )?solutions?/i.test(answer)
    );
}

function agentIsAskingForOffer(answer) {
    if (!answer) return false;
    const text = answer.toLowerCase();
    // Detect when the user (or the agent) brings up private offers /
    // marketplace offers. We're a little permissive — better to show the
    // picker than miss it. The chip still costs nothing to render.
    return (
        text.includes('private offer') ||
        text.includes('marketplace offer') ||
        /(which|what) (private )?offers?/i.test(answer) ||
        /associate.{0,30}(private )?offer/i.test(answer)
    );
}

async function renderSolutionPicker() {
    // Fetch registered solutions and render them as clickable chips above
    // the reply input. Demonstrates the "API + Agent" pattern: the API
    // returns deterministic solution IDs, the agent uses them.
    try {
        const resp = await fetch('/api/partnercentral/solutions');
        const data = await resp.json();
        
        if (!data.success || !data.solutions || data.solutions.length === 0) {
            addCreateAgentMessage(
                'assistant',
                '<em style="color: #aaa;">💡 Tip: I can call the ListSolutions API to fetch your registered solutions, but none were found in your account. You can describe the solution in free text instead (e.g., "AWS migration tooling and managed services").</em>'
            );
            return;
        }
        
        const chipsHtml = data.solutions.map(s => {
            const label = `${s.id} — ${s.name}`;
            const safeLabel = label.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            return `<button class="solution-chip" onclick="pickSolution('${safeLabel}')" style="background: rgba(0,212,255,0.15); border: 1px solid rgba(0,212,255,0.4); color: #00d4ff; padding: 6px 12px; border-radius: 16px; cursor: pointer; font-size: 13px; margin: 4px;">${label}</button>`;
        }).join('');
        
        const helperHtml = `
            <div style="background: rgba(0,255,136,0.08); border-left: 3px solid #00ff88; border-radius: 6px; padding: 12px; margin: 8px 0;">
                <p style="margin-bottom: 8px;"><strong>✨ API + Agent:</strong> I called <code>partnercentral-selling:ListSolutions</code> to fetch your registered solutions. Click one to send to the agent:</p>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">${chipsHtml}</div>
            </div>
        `;
        addCreateAgentMessage('assistant', helperHtml);
    } catch (e) {
        console.warn('Could not fetch solutions:', e);
    }
}

async function renderOfferPicker() {
    // Same idea as renderSolutionPicker, but for AWS Marketplace private
    // offers. Calls aws-marketplace:ListEntities (Targeting=BuyerAccounts)
    // and surfaces the first three as clickable chips so the user can
    // associate one with the opportunity without typing its ID.
    try {
        const resp = await fetch('/api/marketplace/private-offers');
        const data = await resp.json();
        
        if (!data.success || !data.offers || data.offers.length === 0) {
            const errMsg = data.error || 'No private offers found in your account.';
            addCreateAgentMessage(
                'assistant',
                `<em style="color: #aaa;">💡 Tip: I tried calling AWS Marketplace <code>ListEntities</code> for private offers but got: ${errMsg.split('\n')[0]}</em>`
            );
            return;
        }
        
        // Demo: keep it short — first 3 offers, like the solution picker.
        const top = data.offers.slice(0, 3);
        const chipsHtml = top.map(o => {
            const label = `${o.id} — ${o.name}`;
            const safeLabel = label.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            return `<button class="offer-chip" onclick="pickOffer('${safeLabel}')" style="background: rgba(255,193,7,0.15); border: 1px solid rgba(255,193,7,0.4); color: #ffc107; padding: 6px 12px; border-radius: 16px; cursor: pointer; font-size: 13px; margin: 4px;">${label}</button>`;
        }).join('');
        
        const helperHtml = `
            <div style="background: rgba(255,193,7,0.08); border-left: 3px solid #ffc107; border-radius: 6px; padding: 12px; margin: 8px 0;">
                <p style="margin-bottom: 8px;"><strong>✨ API + Agent:</strong> I called <code>aws-marketplace:ListEntities</code> for private offers (top ${top.length} of ${data.offers.length}). Click one to send to the agent:</p>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">${chipsHtml}</div>
                <p style="font-size: 11px; color: #888; margin-top: 8px;">Need <code>aws-marketplace:ListEntities</code> on your IAM user/role. Not included in <code>AWSPartnerCentralSandboxFullAccess</code>.</p>
            </div>
        `;
        addCreateAgentMessage('assistant', helperHtml);
    } catch (e) {
        console.warn('Could not fetch private offers:', e);
    }
}

function pickSolution(label) {
    // Pre-fill the agent reply input with the chosen solution. The user
    // can still edit before sending.
    const input = document.getElementById('create-agent-input');
    input.value = label;
    input.focus();
}

function pickOffer(label) {
    // Same pattern as pickSolution — drop the offer ID into the reply box.
    const input = document.getElementById('create-agent-input');
    input.value = `Associate AWS Marketplace private offer ${label}`;
    input.focus();
}

async function sendCreateAgentReply() {
    const input = document.getElementById('create-agent-input');
    const reply = input.value.trim();
    if (!reply) return;
    
    if (createAgentPendingApproval) {
        alert('Please approve or reject the pending request before sending a new message.');
        return;
    }
    
    addCreateAgentMessage('user', reply);
    input.value = '';
    await sendToCreateAgent(reply);
}

async function sendCreateAgentApproval(decision) {
    if (!createAgentPendingApproval) return;
    
    addCreateAgentMessage('user', decision === 'approve' ? '✓ Approved' : '✗ Rejected');
    document.getElementById('create-agent-loading').style.display = 'block';
    
    try {
        const response = await fetch('/api/create-from-notes-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: createAgentPendingApproval.session_id,
                tool_use_id: createAgentPendingApproval.tool_use_id,
                decision: decision,
                allow_submit: document.getElementById('create-agent-submit-to-aws')?.checked || false
            })
        });
        const data = await response.json();
        console.log('[create-agent-approve] response:', data);
        document.getElementById('create-agent-loading').style.display = 'none';
        
        if (data.error) {
            addCreateAgentMessage('assistant', `❌ ${data.error}`);
            createAgentPendingApproval = null;
        } else if (data.requires_approval) {
            // Agent issued a follow-up tool call (e.g., retry after a
            // validation error). Show a fresh Approve button instead of
            // leaving the user stuck with no way forward.
            if (data.answer) {
                addCreateAgentMessage('assistant', data.answer);
            }
            createAgentPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id
            };
            const approvalHtml = `
                <div style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 10px;">
                    <p><strong>🔐 Approval Required (retry)</strong></p>
                    <p>The agent corrected its request and is asking again. Tool: <code>${data.tool_name}</code></p>
                    <div style="margin-top: 10px;">
                        <button onclick="sendCreateAgentApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve & Create</button>
                        <button onclick="sendCreateAgentApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addCreateAgentMessage('assistant', approvalHtml);
        } else {
            addCreateAgentMessage('assistant', data.answer);
            const oppMatch = data.answer.match(/O\d{8,}/);
            if (oppMatch) {
                await onCreateAgentSuccess(oppMatch[0]);
            }
            createAgentPendingApproval = null;
        }
    } catch (error) {
        document.getElementById('create-agent-loading').style.display = 'none';
        addCreateAgentMessage('assistant', `❌ Error: ${error.message}`);
        createAgentPendingApproval = null;
    }
}

async function onCreateAgentSuccess(aceOpportunityId) {
    // Auto-fill other tabs
    document.getElementById('opp-id').value = aceOpportunityId;
    document.getElementById('chat-opp-id').value = aceOpportunityId;
    
    // Write the ACE ID back to HubSpot deal
    const token = document.getElementById('crm-token').value;
    const spec = _getCurrentCrmSpec();
    
    if (spec.id === 'hubspot' && createAgentRecordId) {
        try {
            await fetch('/api/crm/link-ace-opportunity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    record_id: createAgentRecordId,
                    opportunity_id: aceOpportunityId,
                    token: token,
                    crm_type: spec.id
                })
            });
            addCreateAgentMessage('assistant', `✅ <strong>Linked to HubSpot deal!</strong><br>The ACE opportunity ID <code>${aceOpportunityId}</code> has been written back to the HubSpot deal as <code>partner_central_opportunity_id</code>.`);
        } catch (e) {
            console.error('Failed to write back to HubSpot:', e);
        }
    }
    
    // If the user opted to stop at Pending Submission (default), show a
    // "📤 Submit to AWS" button so they can submit with one click after
    // reviewing in Partner Central.
    const submitChecked = document.getElementById('create-agent-submit-to-aws')?.checked;
    if (!submitChecked) {
        const submitHtml = `
            <div style="background: rgba(0,212,255,0.08); border: 1px solid rgba(0,212,255,0.4); border-radius: 8px; padding: 14px; margin-top: 8px;">
                <p style="margin-bottom: 8px;"><strong>📋 Opportunity is in <em>Pending Submission</em></strong></p>
                <p style="font-size: 13px; color: #ccc; margin-bottom: 10px;">Review it in Partner Central first, then submit to AWS for review when ready.</p>
                <button onclick="submitOpportunityViaAgent('create-agent', '${aceOpportunityId}')" style="background: linear-gradient(135deg, #00d4ff, #00ff88); color: #000; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold;">📤 Submit ${aceOpportunityId} to AWS for review</button>
                <a href="https://partnercentral.awspartner.com/sandbox/Opportunity/${aceOpportunityId}" target="_blank" rel="noopener" style="display: inline-block; margin-left: 8px; padding: 8px 14px; color: #00d4ff; text-decoration: none; border: 1px solid rgba(0,212,255,0.3); border-radius: 6px; font-size: 13px;">🔗 View in Partner Central</a>
            </div>
        `;
        addCreateAgentMessage('assistant', submitHtml);
    }
    
    updateStep(3);
    showResult('crm-result', true,
        `✅ ACE Opportunity Created via Agent!\n\nOpportunity ID: ${aceOpportunityId}\nLinked to ${spec.display_name} ${spec.record_label}: ${createAgentRecordId}`
    );
}

// One-click "submit to AWS" that reuses the existing agent conversation.
// `flow` is either 'create-agent' (CRM tab modal) or 'create-notes' (Notes tab).
async function submitOpportunityViaAgent(flow, aceOpportunityId) {
    if (!confirm(`Submit ${aceOpportunityId} to AWS for review? You'll get an approval prompt before any write happens.`)) {
        return;
    }
    
    const submitMessage = `Now please submit opportunity ${aceOpportunityId} to AWS for review.`;
    
    if (flow === 'create-agent') {
        if (createAgentPendingApproval) {
            alert('There is already a pending approval. Please resolve it first.');
            return;
        }
        // Flip the checkbox so subsequent calls to sendToCreateAgent send
        // allow_submit=true to the backend; otherwise the policy guard
        // would auto-reject the very submit the user just asked for.
        const cb = document.getElementById('create-agent-submit-to-aws');
        if (cb) cb.checked = true;
        addCreateAgentMessage('user', submitMessage);
        await sendToCreateAgent(submitMessage);
    } else if (flow === 'create-notes') {
        if (createNotesPendingApproval) {
            alert('There is already a pending approval. Please resolve it first.');
            return;
        }
        const cb = document.getElementById('create-notes-submit-to-aws');
        if (cb) cb.checked = true;
        const input = document.getElementById('create-notes-reply');
        if (input) input.value = submitMessage;
        await sendCreateNotesReply();
    }
}

function closeCreateAgentModal() {
    document.getElementById('create-agent-modal').classList.remove('active');
}

function updateStep(step) {
    for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(`step${i}`);
        el.classList.remove('active', 'complete');
        if (i < step) el.classList.add('complete');
        if (i === step) el.classList.add('active');
    }
}

async function updateNextSteps() {
    const oppId = document.getElementById('opp-id').value;
    const notes = document.getElementById('meeting-notes').value;
    const prompt = document.getElementById('ai-prompt').value;
    const dryRun = document.getElementById('dry-run').checked;
    const filesInput = document.getElementById('meeting-files');
    const files = filesInput ? filesInput.files : null;
    
    if (!oppId) {
        alert('Please enter an opportunity ID');
        return;
    }
    if (!notes && (!files || files.length === 0)) {
        alert('Please paste meeting notes or select at least one file');
        return;
    }
    
    document.getElementById('update-loading').style.display = 'block';
    document.getElementById('update-result').style.display = 'none';
    document.getElementById('approval-box').style.display = 'none';
    document.getElementById('editable-section').style.display = 'none';
    
    try {
        let response;
        if (files && files.length > 0) {
            // Multipart upload — send notes + files in one request
            const formData = new FormData();
            formData.append('opportunity_id', oppId);
            formData.append('notes', notes);
            formData.append('prompt', prompt);
            for (const file of files) {
                formData.append('files', file);
            }
            response = await fetch('/api/update-next-steps', {
                method: 'POST',
                body: formData
            });
        } else {
            // JSON request (legacy notes-only flow)
            response = await fetch('/api/update-next-steps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    opportunity_id: oppId,
                    notes: notes,
                    prompt: prompt,
                    dry_run: true
                })
            });
        }
        const data = await response.json();
        
        if (data.success || data.next_steps) {
            lastGeneratedNextSteps = data.next_steps;
            let truncatedSteps = data.next_steps;
            if (truncatedSteps.length > 255) {
                truncatedSteps = truncatedSteps.substring(0, 252) + '...';
            }
            document.getElementById('generated-next-steps').value = truncatedSteps;
            updateCharCount();
            document.getElementById('editable-section').style.display = 'block';
            
            // Show source count info if we used files
            if (data.file_count && data.file_count > 0) {
                const infoEl = document.getElementById('update-result');
                infoEl.className = 'result success';
                infoEl.innerHTML = `<pre>📄 Combined ${data.context_source_count} context source(s) — ${data.file_count} file(s) uploaded${notes ? ' + inline notes' : ''}</pre>`;
                infoEl.style.display = 'block';
            }
            
            if (data.warning) {
                const warningHtml = `
                    <div style="background: rgba(255,193,7,0.15); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 15px; color: #ffc107; font-size: 13px; white-space: pre-wrap;">
                        ${escapeHtml(data.warning)}
                    </div>
                `;
                const resultEl = document.getElementById('update-result');
                resultEl.className = 'result success';
                resultEl.innerHTML = (resultEl.innerHTML || '') + warningHtml;
                resultEl.style.display = 'block';
            }
        } else {
            throw new Error(data.error || 'Unknown error');
        }
        
    } catch (error) {
        showResult('update-result', false, error.message);
    } finally {
        document.getElementById('update-loading').style.display = 'none';
    }
}

function onMeetingFilesSelected() {
    const filesInput = document.getElementById('meeting-files');
    const listEl = document.getElementById('meeting-files-list');
    listEl.innerHTML = '';
    if (!filesInput || !filesInput.files || filesInput.files.length === 0) return;
    
    for (const file of filesInput.files) {
        const chip = document.createElement('span');
        chip.style.cssText = 'background: rgba(0,212,255,0.15); border: 1px solid rgba(0,212,255,0.4); border-radius: 16px; padding: 4px 12px; font-size: 12px; color: #00d4ff;';
        chip.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        listEl.appendChild(chip);
    }
}

function onCreateNotesFilesSelected() {
    // Mirrors onMeetingFilesSelected but for the Create-from-Notes panel.
    // Render a chip per selected file so the user sees what will be uploaded.
    const filesInput = document.getElementById('create-notes-files');
    const listEl = document.getElementById('create-notes-files-list');
    listEl.innerHTML = '';
    if (!filesInput || !filesInput.files || filesInput.files.length === 0) return;
    
    for (const file of filesInput.files) {
        const chip = document.createElement('span');
        chip.style.cssText = 'background: rgba(0,212,255,0.15); border: 1px solid rgba(0,212,255,0.4); border-radius: 16px; padding: 4px 12px; font-size: 12px; color: #00d4ff;';
        chip.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        listEl.appendChild(chip);
    }
}

function regenerateNextSteps() {
    updateNextSteps();
}

async function submitNextSteps() {
    const oppId = document.getElementById('opp-id').value;
    const nextSteps = document.getElementById('generated-next-steps').value;
    
    if (!nextSteps.trim()) {
        alert('Next steps cannot be empty');
        return;
    }
    
    document.getElementById('update-loading').style.display = 'block';
    document.getElementById('editable-section').style.display = 'none';
    
    try {
        const response = await fetch('/api/submit-next-steps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opportunity_id: oppId,
                next_steps: nextSteps
            })
        });
        const data = await response.json();
        
        if (data.requires_approval) {
            currentSessionId = data.session_id;
            currentToolUseId = data.tool_use_id;
            document.getElementById('approval-details').innerHTML = `
                <p><strong>Tool:</strong> ${data.tool_name}</p>
                <p><strong>Next Steps to Submit:</strong></p>
                <pre>${nextSteps}</pre>
            `;
            document.getElementById('approval-box').style.display = 'block';
        } else if (data.success) {
            showResult('update-result', true, `✅ Next Steps Updated!\n\n${nextSteps}`);
        } else {
            throw new Error(data.error || 'Unknown error');
        }
        
    } catch (error) {
        showResult('update-result', false, error.message);
        document.getElementById('editable-section').style.display = 'block';
    } finally {
        document.getElementById('update-loading').style.display = 'none';
    }
}

async function sendApproval(decision) {
    document.getElementById('approval-box').style.display = 'none';
    document.getElementById('update-loading').style.display = 'block';
    
    try {
        const response = await fetch('/api/send-approval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: currentSessionId,
                tool_use_id: currentToolUseId,
                decision: decision
            })
        });
        const data = await response.json();
        
        if (decision === 'approve' && data.success) {
            showResult('update-result', true, '✅ Opportunity updated successfully!');
        } else if (decision === 'reject') {
            showResult('update-result', false, '❌ Update rejected by user.');
        } else {
            throw new Error(data.error || 'Approval failed');
        }
        
    } catch (error) {
        showResult('update-result', false, error.message);
    } finally {
        document.getElementById('update-loading').style.display = 'none';
    }
}

function showResult(elementId, success, message) {
    const el = document.getElementById(elementId);
    el.className = `result ${success ? 'success' : 'error'}`;
    el.innerHTML = `<pre>${message}</pre>`;
    el.style.display = 'block';
}

function updateCharCount() {
    const textarea = document.getElementById('generated-next-steps');
    const counter = document.getElementById('char-count');
    const len = textarea.value.length;
    counter.textContent = len + '/255';
    counter.style.color = len > 240 ? '#ff4444' : (len > 200 ? '#ffc107' : '#888');
}

// Chat functions
function askExample(el) {
    document.getElementById('chat-input').value = el.textContent;
    sendChatMessage();
}

function addChatMessage(role, content) {
    const messagesDiv = document.getElementById('chat-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.innerHTML = `<div class="message-content">${content}</div>`;
    messagesDiv.appendChild(msgDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function clearChat() {
    chatSessionId = null;
    document.getElementById('chat-messages').innerHTML = `
        <div class="message system">
            Conversation cleared. Start a new conversation by asking a question.
        </div>
    `;
}

let chatPendingApproval = null;  // Store pending approval for chat

async function sendChatMessage() {
    const oppId = document.getElementById('chat-opp-id').value;
    const input = document.getElementById('chat-input');
    const question = input.value.trim();
    
    if (!question) {
        return;
    }
    
    // Add user message to chat
    addChatMessage('user', question);
    input.value = '';
    
    // Add loading indicator
    const loadingId = 'loading-' + Date.now();
    const messagesDiv = document.getElementById('chat-messages');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = loadingId;
    loadingDiv.className = 'message assistant';
    loadingDiv.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:0;"></div>';
    messagesDiv.appendChild(loadingDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opportunity_id: oppId,
                question: question,
                session_id: chatSessionId
            })
        });
        const data = await response.json();
        
        // Remove loading indicator
        document.getElementById(loadingId).remove();
        
        if (data.error) {
            addChatMessage('assistant', `❌ Error: ${data.error}`);
        } else if (data.requires_approval) {
            // Handle approval request for update operations
            chatSessionId = data.session_id;
            
            // Generate unique ID for this approval box
            const approvalId = 'approval-' + Date.now();
            
            chatPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id,
                tool_name: data.tool_name,
                approval_id: approvalId  // Store the ID for later reference
            };
            
            // Show approval message with buttons (with unique ID for removal)
            const approvalHtml = `
                <div id="${approvalId}" style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 10px;">
                    <p><strong>🔐 Approval Required</strong></p>
                    <p>Tool: <code>${data.tool_name}</code></p>
                    <div id="${approvalId}-buttons" style="margin-top: 10px;">
                        <button onclick="sendChatApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve</button>
                        <button onclick="sendChatApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addChatMessage('assistant', approvalHtml);
        } else {
            chatSessionId = data.session_id;
            addChatMessage('assistant', data.answer);
        }
        
    } catch (error) {
        document.getElementById(loadingId).remove();
        addChatMessage('assistant', `❌ Error: ${error.message}`);
    }
}

async function sendChatApproval(decision) {
    if (!chatPendingApproval) {
        addChatMessage('assistant', '❌ No pending approval found.');
        return;
    }
    
    // Get the approval ID from the stored object
    const approvalId = chatPendingApproval.approval_id;
    
    // Disable and hide the approval buttons immediately
    const buttonsDiv = document.getElementById(approvalId + '-buttons');
    if (buttonsDiv) {
        buttonsDiv.innerHTML = '<span style="color: #888;">Processing...</span>';
    }
    
    // Add loading indicator
    const loadingId = 'loading-' + Date.now();
    const messagesDiv = document.getElementById('chat-messages');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = loadingId;
    loadingDiv.className = 'message assistant';
    loadingDiv.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:0;"></div>';
    messagesDiv.appendChild(loadingDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    try {
        const response = await fetch('/api/send-approval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: chatPendingApproval.session_id,
                tool_use_id: chatPendingApproval.tool_use_id,
                decision: decision
            })
        });
        const data = await response.json();
        console.log('[chat-approve] response:', data);
        
        // Remove loading indicator
        document.getElementById(loadingId).remove();
        
        const approvalBox = document.getElementById(approvalId);
        
        // Helper: extract a Pending Submission funding-request URL from the
        // agent narrative, if one is mentioned.
        const detectFundingRequest = (text) => {
            if (!text) return null;
            const m = text.match(/benappl-[a-zA-Z0-9]+/);
            return m ? m[0] : null;
        };
        
        if (decision === 'reject') {
            if (approvalBox) {
                approvalBox.style.background = 'rgba(255,68,68,0.1)';
                approvalBox.style.borderColor = '#ff4444';
                approvalBox.innerHTML = '<p><strong>❌ Rejected</strong></p><p style="color: #ff4444;">Action was rejected.</p>';
            }
        } else if (data.requires_approval) {
            // The agent issued a follow-up tool call (e.g., retry after a
            // recoverable failure). Render a fresh approval prompt.
            if (approvalBox) {
                approvalBox.style.background = 'rgba(255,193,7,0.1)';
                approvalBox.style.borderColor = '#ffc107';
                approvalBox.innerHTML = '<p><strong>✓ Approved (previous step)</strong></p>';
            }
            if (data.message) addChatMessage('assistant', data.message);
            
            const newApprovalId = 'approval-' + Date.now();
            chatPendingApproval = {
                session_id: chatPendingApproval.session_id,
                tool_use_id: data.tool_use_id,
                approval_id: newApprovalId,
            };
            const retryHtml = `
                <div id="${newApprovalId}" class="approval-box" style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px;">
                    <p><strong>🔐 Approval Required (retry)</strong></p>
                    <p>The agent issued a follow-up call. Tool: <code>${data.tool_name}</code></p>
                    <div id="${newApprovalId}-buttons" style="margin-top: 10px;">
                        <button onclick="sendChatApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve</button>
                        <button onclick="sendChatApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addChatMessage('assistant', retryHtml);
        } else if (data.success) {
            if (approvalBox) {
                approvalBox.style.background = 'rgba(0,255,136,0.1)';
                approvalBox.style.borderColor = '#00ff88';
                approvalBox.innerHTML = '<p><strong>✅ Approved & Completed</strong></p>';
            }
            // Show the agent's narrative so the user sees the actual outcome
            // (e.g., funding request id, stage transition confirmation).
            if (data.message) {
                addChatMessage('assistant', data.message);
                const benapplId = detectFundingRequest(data.message);
                if (benapplId) {
                    addChatMessage(
                        'assistant',
                        `<div style="background: rgba(0,212,255,0.08); border: 1px solid rgba(0,212,255,0.4); border-radius: 8px; padding: 12px; margin-top: 8px;">
                            <p><strong>📋 Funding request created:</strong> <code>${benapplId}</code></p>
                            <p style="font-size: 12px; color: #aaa;">View it in Partner Central → Funding Programs → Benefit Applications.</p>
                        </div>`
                    );
                }
            }
            chatPendingApproval = null;
        } else {
            // success === false → tool call failed inside MCP (e.g., validation error)
            if (approvalBox) {
                approvalBox.style.background = 'rgba(255,68,68,0.1)';
                approvalBox.style.borderColor = '#ff4444';
                approvalBox.innerHTML = `<p><strong>❌ Action failed</strong></p><p style="color: #ff4444; font-size: 12px;">${(data.error || 'Unknown error').slice(0, 200)}</p>`;
            }
            if (data.message) {
                addChatMessage('assistant', data.message);
            } else if (data.error) {
                addChatMessage('assistant', `❌ ${data.error}`);
            }
            chatPendingApproval = null;
        }
        
        // Always clear the pending approval reference unless we set a new one.
        if (!data.requires_approval) {
            chatPendingApproval = null;
        }
        
    } catch (error) {
        document.getElementById(loadingId).remove();
        // Update approval box to show error
        const approvalBox = document.getElementById(approvalId);
        if (approvalBox) {
            const buttonsDiv = document.getElementById(approvalId + '-buttons');
            if (buttonsDiv) {
                buttonsDiv.innerHTML = `<span style="color: #ff4444;">Error: ${error.message}</span>`;
            }
        }
        addChatMessage('assistant', `❌ Error: ${error.message}`);
    }
}

// ----------------------------------------------------------------
// Create from Notes functions
// ----------------------------------------------------------------
let createNotesSessionId = null;
let createNotesPendingApproval = null;

// Shared helper: render the success block in the Notes tab. If the user
// chose "create only" (default), include a "Submit to AWS" button so the
// next step is one click instead of typing a follow-up message.
function renderCreateNotesSuccess(aceOpportunityId) {
    const submitChecked = document.getElementById('create-notes-submit-to-aws')?.checked;
    const submitBlock = submitChecked ? '' : `
        <div style="background: rgba(0,212,255,0.08); border: 1px solid rgba(0,212,255,0.4); border-radius: 8px; padding: 14px; margin-top: 10px;">
            <p style="margin-bottom: 8px;"><strong>📋 Opportunity is in <em>Pending Submission</em></strong></p>
            <p style="font-size: 13px; color: #ccc; margin-bottom: 10px;">Review it in Partner Central first, then submit to AWS for review when ready.</p>
            <button onclick="submitOpportunityViaAgent('create-notes', '${aceOpportunityId}')" style="background: linear-gradient(135deg, #00d4ff, #00ff88); color: #000; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold;">📤 Submit ${aceOpportunityId} to AWS for review</button>
            <a href="https://partnercentral.awspartner.com/sandbox/Opportunity/${aceOpportunityId}" target="_blank" rel="noopener" style="display: inline-block; margin-left: 8px; padding: 8px 14px; color: #00d4ff; text-decoration: none; border: 1px solid rgba(0,212,255,0.3); border-radius: 6px; font-size: 13px;">🔗 View in Partner Central</a>
        </div>
    `;
    document.getElementById('create-notes-result').innerHTML = `
        <div style="background: rgba(0,255,136,0.1); border: 1px solid #00ff88; border-radius: 8px; padding: 15px;">
            <strong>✅ Opportunity Created!</strong><br>
            ACE Opportunity ID: <code>${aceOpportunityId}</code>
        </div>
        ${submitBlock}
    `;
    document.getElementById('opp-id').value = aceOpportunityId;
    document.getElementById('chat-opp-id').value = aceOpportunityId;
}

function addCreateNotesMessage(role, content) {
    const container = document.getElementById('create-notes-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.style.padding = '10px';
    msgDiv.style.marginBottom = '10px';
    msgDiv.style.borderRadius = '6px';
    msgDiv.style.background = role === 'user' ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.05)';
    
    // Format assistant messages as markdown; user messages and HTML (like approval boxes) pass through.
    const looksLikeHtml = /<\/?(div|button|p|strong|em|code|ul|ol|li|pre|br)\b/i.test(content);
    const formattedContent = (role === 'assistant' && !looksLikeHtml) ? formatAgentMarkdown(content) : content;
    
    msgDiv.innerHTML = `<strong>${role === 'user' ? 'You' : '🤖 Partner Central Agent'}:</strong>${formattedContent}`;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

async function createFromNotes() {
    const notes = document.getElementById('create-notes-input').value.trim();
    const instructions = document.getElementById('create-notes-instructions').value.trim();
    const filesInput = document.getElementById('create-notes-files');
    const files = filesInput ? filesInput.files : null;
    
    if (!notes && (!files || files.length === 0)) {
        alert('Please paste meeting notes, upload at least one file, or both.');
        return;
    }
    
    // Show status area
    document.getElementById('create-notes-status').style.display = 'block';
    document.getElementById('create-notes-loading').style.display = 'block';
    document.getElementById('create-notes-result').innerHTML = '';
    document.getElementById('create-notes-conversation').style.display = 'block';
    document.getElementById('create-notes-messages').innerHTML = '';
    document.getElementById('create-notes-reply-container').classList.remove('hidden');
    document.getElementById('create-notes-btn').disabled = true;
    
    // Build the agent prompt around the inline notes (we'll append file
    // contents server-side so the agent treats notes + files as one bundle).
    let prompt;
    if (notes) {
        prompt = `Create an opportunity from the following meeting notes:\n\n${notes}`;
    } else {
        prompt = `Create an opportunity from the meeting notes I'm uploading.`;
    }
    if (instructions) {
        prompt += `\n\nAdditional instructions: ${instructions}`;
    }
    
    // Tell the agent how far to go. Default is "create only" so the
    // opportunity lands in Pending Submission and the user can review
    // it in Partner Central before submitting to AWS.
    const submitToAws = document.getElementById('create-notes-submit-to-aws')?.checked;
    if (submitToAws) {
        prompt += `\n\nIMPORTANT: After creating the opportunity, submit it to AWS for review. Confirm with me before submission.`;
    } else {
        prompt += `\n\nIMPORTANT: Create the opportunity only — do NOT submit it to AWS for review. Leave it in "Pending Submission" status so I can review it in Partner Central first. Stop after the opportunity is successfully created.`;
    }
    
    // Friendly preview message in the conversation log
    const fileSummary = files && files.length > 0
        ? ` plus ${files.length} file${files.length > 1 ? 's' : ''}`
        : '';
    const previewSnippet = notes
        ? notes.substring(0, 200) + (notes.length > 200 ? '...' : '')
        : (files && files.length > 0
            ? Array.from(files).map(f => `📄 ${f.name}`).join(', ')
            : '');
    addCreateNotesMessage('user', `<strong>Creating opportunity from notes${fileSummary}...</strong><br><em>${previewSnippet}</em>`);
    
    try {
        let response;
        if (files && files.length > 0) {
            // Multipart — backend concatenates inline notes + file contents
            const formData = new FormData();
            formData.append('notes', prompt);
            if (createNotesSessionId) formData.append('session_id', createNotesSessionId);
            formData.append('allow_submit', String(!!submitToAws));
            for (const file of files) {
                formData.append('files', file);
            }
            response = await fetch('/api/create-from-notes', {
                method: 'POST',
                body: formData
            });
        } else {
            response = await fetch('/api/create-from-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    notes: prompt,
                    session_id: createNotesSessionId,
                    allow_submit: !!submitToAws
                })
            });
        }
        
        const data = await response.json();
        document.getElementById('create-notes-loading').style.display = 'none';
        
        if (data.error) {
            addCreateNotesMessage('assistant', `❌ Error: ${data.error}`);
            document.getElementById('create-notes-btn').disabled = false;
        } else if (data.requires_approval) {
            createNotesSessionId = data.session_id;
            createNotesPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id
            };
            
            const approvalHtml = `
                <div style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 10px;">
                    <p><strong>🔐 Approval Required</strong></p>
                    <p>The agent wants to create the opportunity. Tool: <code>${data.tool_name}</code></p>
                    <div style="margin-top: 10px;">
                        <button onclick="sendCreateNotesApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve & Create</button>
                        <button onclick="sendCreateNotesApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addCreateNotesMessage('assistant', approvalHtml);
        } else if (data.needs_more_info) {
            createNotesSessionId = data.session_id;
            addCreateNotesMessage('assistant', data.answer);
            // Show reply input for user to provide more info
            document.getElementById('create-notes-reply-container').classList.remove('hidden');
            document.getElementById('create-notes-btn').disabled = false;
        } else {
            createNotesSessionId = data.session_id;
            addCreateNotesMessage('assistant', data.answer);
            
            // Check if opportunity was created (look for opportunity ID pattern)
            const oppMatch = data.answer.match(/O\d{8,}/);
            if (oppMatch) {
                renderCreateNotesSuccess(oppMatch[0]);
            }
            document.getElementById('create-notes-btn').disabled = false;
        }
        
    } catch (error) {
        document.getElementById('create-notes-loading').style.display = 'none';
        addCreateNotesMessage('assistant', `❌ Error: ${error.message}`);
        document.getElementById('create-notes-btn').disabled = false;
    }
}

async function sendCreateNotesReply() {
    const input = document.getElementById('create-notes-reply');
    const reply = input.value.trim();
    if (!reply) return;
    
    // Block sending replies while an approval is pending — sending a new
    // message would cause the MCP server to issue a fresh approval id and
    // invalidate the one tied to the visible Approve/Reject buttons.
    if (createNotesPendingApproval) {
        alert('Please approve or reject the pending request before sending a new message.');
        return;
    }
    
    addCreateNotesMessage('user', reply);
    input.value = '';
    
    document.getElementById('create-notes-loading').style.display = 'block';
    
    try {
        const allowSubmit = document.getElementById('create-notes-submit-to-aws')?.checked || false;
        const response = await fetch('/api/create-from-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                notes: reply,
                session_id: createNotesSessionId,
                allow_submit: allowSubmit
            })
        });
        
        const data = await response.json();
        document.getElementById('create-notes-loading').style.display = 'none';
        
        if (data.error) {
            addCreateNotesMessage('assistant', `❌ Error: ${data.error}`);
        } else if (data.requires_approval) {
            createNotesSessionId = data.session_id;
            createNotesPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id
            };
            const approvalHtml = `
                <div style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px;">
                    <p><strong>🔐 Approval Required</strong></p>
                    <p>Tool: <code>${data.tool_name}</code></p>
                    <div style="margin-top: 10px;">
                        <button onclick="sendCreateNotesApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve & Create</button>
                        <button onclick="sendCreateNotesApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addCreateNotesMessage('assistant', approvalHtml);
        } else {
            createNotesSessionId = data.session_id;
            addCreateNotesMessage('assistant', data.answer);
            
            const oppMatch = data.answer.match(/O\d{8,}/);
            if (oppMatch) {
                renderCreateNotesSuccess(oppMatch[0]);
            }
        }
    } catch (error) {
        document.getElementById('create-notes-loading').style.display = 'none';
        addCreateNotesMessage('assistant', `❌ Error: ${error.message}`);
    }
}

async function sendCreateNotesApproval(decision) {
    if (!createNotesPendingApproval) {
        addCreateNotesMessage('assistant', '❌ No pending approval found.');
        return;
    }
    
    addCreateNotesMessage('user', decision === 'approve' ? '✓ Approved' : '✗ Rejected');
    document.getElementById('create-notes-loading').style.display = 'block';
    
    try {
        const response = await fetch('/api/create-from-notes-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: createNotesPendingApproval.session_id,
                tool_use_id: createNotesPendingApproval.tool_use_id,
                decision: decision,
                allow_submit: document.getElementById('create-notes-submit-to-aws')?.checked || false
            })
        });
        
        const data = await response.json();
        console.log('[create-notes-approve] response:', data);
        document.getElementById('create-notes-loading').style.display = 'none';
        
        if (data.error) {
            addCreateNotesMessage('assistant', `❌ ${data.error}`);
            createNotesPendingApproval = null;
        } else if (data.requires_approval) {
            // The agent issued a follow-up tool call (e.g., retried after a
            // validation error). Show the assistant narrative and a fresh
            // Approve/Reject prompt for the new tool_use_id.
            if (data.answer) {
                addCreateNotesMessage('assistant', data.answer);
            }
            createNotesPendingApproval = {
                session_id: data.session_id,
                tool_use_id: data.tool_use_id
            };
            const approvalHtml = `
                <div style="background: rgba(255,193,7,0.2); border: 1px solid #ffc107; border-radius: 8px; padding: 15px;">
                    <p><strong>🔐 Approval Required (retry)</strong></p>
                    <p>The agent corrected its request and is asking again. Tool: <code>${data.tool_name}</code></p>
                    <div style="margin-top: 10px;">
                        <button onclick="sendCreateNotesApproval('approve')" style="background: #00ff88; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">✓ Approve & Create</button>
                        <button onclick="sendCreateNotesApproval('reject')" style="background: #ff4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">✗ Reject</button>
                    </div>
                </div>
            `;
            addCreateNotesMessage('assistant', approvalHtml);
        } else {
            addCreateNotesMessage('assistant', data.answer);
            
            const oppMatch = data.answer.match(/O\d{8,}/);
            if (oppMatch) {
                renderCreateNotesSuccess(oppMatch[0]);
            }
            createNotesPendingApproval = null;
        }
        
        document.getElementById('create-notes-btn').disabled = false;
        
    } catch (error) {
        document.getElementById('create-notes-loading').style.display = 'none';
        addCreateNotesMessage('assistant', `❌ Error: ${error.message}`);
    }
}
