// Copyright (c) 2026, kariukinyutu and contributors
// For license information, please see license.txt

frappe.ui.form.on("JPL Project Approval Request", {
    refresh(frm) {
        frm.set_df_property("review_comments", "hidden", 1);
        render_reviews(frm, 5);

        if (!$("#jpl-par-styles").length) {
            $('<style id="jpl-par-styles">').html(`
                [data-fieldname="documents"] [data-fieldname="view_document"],
                [data-fieldname="documents"] [data-fieldname="view_document"] .btn {
                    display: inline-block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                }
                [data-fieldname="documents"] [data-fieldname="view_document"] .btn {
                    background-color: #22c55e !important;
                    border-color: #22c55e !important;
                    color: #fff !important;
                }
                [data-fieldname="documents"] [data-fieldname="view_document"] .btn:hover {
                    background-color: #16a34a !important;
                    border-color: #16a34a !important;
                    color: #fff !important;
                }
            `).appendTo("head");
        }

        if (frm.doc.__islocal) return;

        // Suppress the Submit button — approval is handled via the custom flow, not doctype submit
        frm.toolbar.can_submit = () => false;
        frm.toolbar.set_primary_action();

        let matrix = frm.doc.approval_matrix || [];
        let has_pending = matrix.some(r => r.status === "Pending");
        let has_rejected = matrix.some(r => r.status === "Rejected");
        let current_user = frappe.session.user;
        let my_pending_row = matrix.find(r => r.approver === current_user && r.status === "Pending");

        if (has_rejected) {
            frm.disable_form();
            frm.add_custom_button(__("Create New Version"), () => open_new_version_dialog(frm));
            return;
        }

        // Only the active pending approver may add review comments
        if (my_pending_row) {
            frm.add_custom_button(__("Add Review Comment"), () => open_review_dialog(frm));
        }
        setup_approval_buttons(frm);

        // Lock form for everyone except the active pending approver
        if (has_pending && !my_pending_row) {
            frm.disable_form();
        }
    }
});

function open_review_dialog(frm, prefill_doc_type) {
    let doc_types = (frm.doc.documents || [])
        .map(d => d.document_type)
        .filter(Boolean);

    let options = ["General", ...new Set(doc_types)];

    let dialog = new frappe.ui.Dialog({
        title: __("Add Review Comment"),
        fields: [
            {
                fieldname: "document_type",
                label: __("Relates To"),
                fieldtype: "Select",
                options: options.join("\n"),
                default: prefill_doc_type || "General",
                reqd: 1
            },
            {
                fieldname: "comment",
                label: __("Comment"),
                fieldtype: "Small Text",
                reqd: 1
            }
        ],
        primary_action_label: __("Submit"),
        primary_action(values) {
            frappe.call({
                method: "jpl_esign.jpl_e_sign.doctype.jpl_project_approval_request.jpl_project_approval_request.save_review_comment",
                args: {
                    docname: frm.doc.name,
                    document_type: values.document_type,
                    comment: values.comment
                },
                btn: dialog.get_primary_btn(),
                callback(r) {
                    if (!r.exc) {
                        frappe.show_alert({ message: __("Comment saved"), indicator: "green" });
                        dialog.hide();
                        frm.reload_doc();
                    }
                }
            });
        }
    });

    dialog.show();
}

function setup_approval_buttons(frm) {
    let matrix = frm.doc.approval_matrix || [];
    let current_user = frappe.session.user;

    let has_pending = matrix.some(r => r.status === "Pending");
    let has_rejected = matrix.some(r => r.status === "Rejected");
    let all_blank = matrix.every(r => !r.status);

    let my_pending_row = matrix.find(r => r.approver === current_user && r.status === "Pending");

    // "Submit for Approval" — initial submission (all blank) or resubmission after rejection
    let can_submit = matrix.length && (all_blank || (has_rejected && !has_pending));
    if (can_submit) {
        let first_row = matrix.slice().sort((a, b) => a.idx - b.idx)[0];
        let first_role = (first_row && first_row.role) || "Approval";
        let btn_label = __("Submit for {0} Approval", [first_role]);

        frm.add_custom_button(btn_label, () => {
            let msg = has_rejected
                ? __("Reset and resubmit to {0} for a fresh review?", [first_role])
                : __("Send this request to {0} for review?", [first_role]);
            frappe.confirm(msg, () => {
                frappe.call({
                    method: "jpl_esign.jpl_e_sign.doctype.jpl_project_approval_request.jpl_project_approval_request.submit_for_approval",
                    args: { docname: frm.doc.name },
                    callback(r) {
                        if (!r.exc) {
                            frappe.show_alert({ message: __("Submitted for approval"), indicator: "blue" });
                            frm.reload_doc();
                        }
                    }
                });
            });
        }, __("Approval"));
    }

    // Approve / Reject — visible only to the current pending approver
    if (my_pending_row) {
        frm.add_custom_button(__("Approve"), () => {
            open_approval_action_dialog(frm, my_pending_row.name, "Approved");
        }, __("Approval"));

        frm.add_custom_button(__("Reject"), () => {
            open_approval_action_dialog(frm, my_pending_row.name, "Rejected");
        }, __("Approval"));

        frm.page.btn_primary.parent().find(`button:contains("Reject")`).addClass("btn-danger").removeClass("btn-default");
    }
}

function open_approval_action_dialog(frm, row_name, action) {
    let is_reject = action === "Rejected";

    let dialog = new frappe.ui.Dialog({
        title: is_reject ? __("Reject Request") : __("Approve Request"),
        fields: [
            {
                fieldname: "remarks",
                label: is_reject ? __("Reason for Rejection") : __("Remarks (optional)"),
                fieldtype: "Small Text",
                reqd: is_reject ? 1 : 0
            }
        ],
        primary_action_label: is_reject ? __("Reject") : __("Approve"),
        primary_action(values) {
            frappe.call({
                method: "jpl_esign.jpl_e_sign.doctype.jpl_project_approval_request.jpl_project_approval_request.record_approval_action",
                args: {
                    docname: frm.doc.name,
                    row_name: row_name,
                    action: action,
                    remarks: values.remarks || ""
                },
                btn: dialog.get_primary_btn(),
                callback(r) {
                    if (!r.exc) {
                        let indicator = action === "Approved" ? "green" : "red";
                        frappe.show_alert({ message: __(action), indicator });
                        dialog.hide();
                        frm.reload_doc();
                    }
                }
            });
        }
    });

    // Colour the dialog's primary button to match the action
    if (is_reject) {
        dialog.get_primary_btn().removeClass("btn-primary").addClass("btn-danger");
    }

    dialog.show();
}

function suggest_next_version(version) {
    let parts = (version || "1.0").split(".");
    parts[0] = String(parseInt(parts[0] || "1") + 1);
    parts[1] = "0";
    return parts.slice(0, 2).join(".");
}

function open_new_version_dialog(frm) {
    let dialog = new frappe.ui.Dialog({
        title: __("Create New Version"),
        fields: [
            {
                fieldname: "info",
                fieldtype: "HTML",
                options: `
                    <div style="
                        background:#f0f7ff; border:1px solid #bfdbfe;
                        border-radius:6px; padding:10px 14px; margin-bottom:4px;
                        font-size:12px; color:#1e40af; line-height:1.6;
                    ">
                        Creates a new approval request based on
                        <strong>${frappe.utils.escape_html(frm.doc.name)}</strong>,
                        carrying over all attached documents.
                        Review comments start fresh on the new version.
                    </div>`
            },
            {
                fieldname: "new_version",
                label: __("New Version"),
                fieldtype: "Data",
                default: suggest_next_version(frm.doc.version),
                reqd: 1,
                description: __("e.g. 2.0, 1.1")
            }
        ],
        primary_action_label: __("Create"),
        primary_action(values) {
            frappe.call({
                method: "jpl_esign.jpl_e_sign.doctype.jpl_project_approval_request.jpl_project_approval_request.create_new_version",
                args: {
                    docname: frm.doc.name,
                    new_version: values.new_version
                },
                btn: dialog.get_primary_btn(),
                callback(r) {
                    if (!r.exc) {
                        frappe.show_alert({ message: __("New version created"), indicator: "green" });
                        dialog.hide();
                        frappe.set_route("Form", "JPL Project Approval Request", r.message);
                    }
                }
            });
        }
    });

    dialog.show();
}

const REVIEWS_PAGE_SIZE = 5;

function render_reviews(frm, limit) {
    let all_comments = (frm.doc.review_comments || [])
        .slice()
        .sort((a, b) => new Date(b.commented_on) - new Date(a.commented_on));

    let $wrapper = frm.fields_dict.reviews.$wrapper;

    if (!all_comments.length) {
        $wrapper.html(`
            <div style="display:flex; flex-direction:column; align-items:center; padding:32px 16px; color:#8d99a6;">
                <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round"
                        d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/>
                </svg>
                <p style="margin-top:12px; font-size:13px;">No reviews yet.</p>
            </div>
        `);
        return;
    }

    const avatar_colors = ["#4f9cf9","#f97316","#22c55e","#a855f7","#ec4899","#14b8a6","#f59e0b"];
    let visible = all_comments.slice(0, limit);
    let hidden_count = all_comments.length - visible.length;

    let cards = visible.map((c, i) => {
        let user = c.commented_by || "?";
        let initials = user.split("@")[0].slice(0, 2).toUpperCase();
        let color = avatar_colors[i % avatar_colors.length];
        let date_str = frappe.datetime.str_to_user(c.commented_on);
        let is_last = i === visible.length - 1 && !hidden_count;

        return `
        <div style="display:flex; gap:12px; margin-bottom:${is_last ? "0" : "4px"};">
            <div style="display:flex; flex-direction:column; align-items:center; flex-shrink:0;">
                <div style="
                    width:34px; height:34px; border-radius:50%;
                    background:${color}22; border:1.5px solid ${color};
                    display:flex; align-items:center; justify-content:center;
                    font-size:11px; font-weight:600; color:${color}; letter-spacing:0.5px;
                ">${initials}</div>
                ${!is_last ? `<div style="width:1.5px; flex:1; background:#e2e8f0; margin-top:4px;"></div>` : ""}
            </div>
            <div style="flex:1; margin-bottom:${is_last ? "0" : "16px"};">
                <div style="
                    background:#fff; border:1px solid #e2e8f0;
                    border-radius:8px; padding:12px 14px;
                    box-shadow:0 1px 3px rgba(0,0,0,0.04);
                ">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:12px; font-weight:600; color:#1a202c;">
                                ${frappe.utils.escape_html(user.split("@")[0])}
                            </span>
                            <span style="
                                background:${color}18; color:${color};
                                border:1px solid ${color}44;
                                font-size:10px; font-weight:600;
                                padding:1px 7px; border-radius:20px; letter-spacing:0.3px;
                            ">${frappe.utils.escape_html(c.document_type || "General")}</span>
                        </div>
                        <span style="font-size:11px; color:#94a3b8; white-space:nowrap;">${date_str}</span>
                    </div>
                    <p style="
                        margin:0; font-size:13px; color:#374151;
                        line-height:1.6; white-space:pre-wrap;
                    ">${frappe.utils.escape_html(c.comment || "")}</p>
                </div>
            </div>
        </div>`;
    }).join("");

    let footer = "";
    if (hidden_count > 0) {
        footer = `
            <div style="text-align:center; padding:12px 0 4px;">
                <button class="btn btn-xs btn-default reviews-load-more" style="color:#4f9cf9; border-color:#4f9cf9;">
                    Load ${Math.min(hidden_count, REVIEWS_PAGE_SIZE)} more
                    <span style="color:#94a3b8; font-weight:400;">(${hidden_count} remaining)</span>
                </button>
            </div>`;
    } else if (limit > REVIEWS_PAGE_SIZE) {
        footer = `
            <div style="text-align:center; padding:12px 0 4px;">
                <button class="btn btn-xs btn-default reviews-collapse" style="color:#94a3b8;">
                    Show less
                </button>
            </div>`;
    }

    $wrapper.html(`<div style="padding:4px 0;">${cards}</div>${footer}`);

    $wrapper.find(".reviews-load-more").on("click", () => {
        render_reviews(frm, limit + REVIEWS_PAGE_SIZE);
    });

    $wrapper.find(".reviews-collapse").on("click", () => {
        render_reviews(frm, REVIEWS_PAGE_SIZE);
    });
}

frappe.ui.form.on("JPL Project Approval Request Item", {
    view_document(frm, cdt, cdn) {
        let row = locals[cdt][cdn];

        if (!row.attachment) {
            frappe.msgprint("No document attached");
            return;
        }

        let fileUrl = row.attachment;
        let ext = fileUrl.split('.').pop().toLowerCase().split('?')[0];

        let dialog = new frappe.ui.Dialog({
            title: row.document_type + " for " + frm.doc.project_name,
            size: "extra-large",
            fields: [
                {
                    fieldtype: "HTML",
                    fieldname: "file_viewer"
                }
            ]
        });

        dialog.show();

        let viewerHtml;
        if (ext === 'pdf') {
            viewerHtml = `
                <iframe
                    src="${fileUrl}"
                    width="100%"
                    height="700px"
                    style="border:none;"
                ></iframe>`;
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
            viewerHtml = `
                <div style="text-align:center; padding:10px; overflow:auto; max-height:700px;">
                    <img
                        src="${fileUrl}"
                        style="max-width:100%; object-fit:contain;"
                        alt="Document Preview"
                    />
                </div>`;
        } else if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
            viewerHtml = `
                <div style="text-align:center; padding:40px;">
                    <p style="margin-bottom:16px;">
                        <strong>${ext.toUpperCase()}</strong> files cannot be previewed in the browser.
                    </p>
                    <a href="${fileUrl}" download class="btn btn-primary">
                        <i class="fa fa-download"></i>&nbsp; Download File
                    </a>
                </div>`;
        } else {
            viewerHtml = `
                <div style="text-align:center; padding:40px;">
                    <p style="margin-bottom:16px;">Preview not available for this file type.</p>
                    <a href="${fileUrl}" download class="btn btn-primary">
                        <i class="fa fa-download"></i>&nbsp; Download File
                    </a>
                </div>`;
        }

        dialog.fields_dict.file_viewer.$wrapper.html(viewerHtml);

        dialog.set_secondary_action(() => {
            open_review_dialog(frm, row.document_type);
        });

        dialog.set_secondary_action_label(__('Add Comment'));
    }
});