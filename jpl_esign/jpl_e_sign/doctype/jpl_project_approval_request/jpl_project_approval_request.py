# Copyright (c) 2026, kariukinyutu and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, get_url_to_form



class JPLProjectApprovalRequest(Document):
    def autoname(self):
        self.name = f"PAR-{self.project_name}-v{self.version}"

    def onload(self):
        if self.approval_matrix:
            return
        settings = frappe.get_single("JPL E-Sign Settings")
        for row in settings.default_approvers or []:
            self.append("approval_matrix", {
                "role": row.role,
                "approver": row.approver,
            })

    def validate(self):
        if frappe.flags.from_approval_action:
            return
        matrix = self.approval_matrix or []
        if any(r.status == "Pending" for r in matrix):
            frappe.throw("This document is locked while approval is in progress.")
        if any(r.status == "Rejected" for r in matrix):
            frappe.throw("This document has been rejected. Create a new version to make changes.")


@frappe.whitelist()
def create_new_version(docname, new_version):
    source = frappe.get_doc("JPL Project Approval Request", docname)

    new_doc = frappe.new_doc("JPL Project Approval Request")
    new_doc.project_name = source.project_name
    new_doc.product_owner = source.product_owner
    new_doc.version = new_version
    new_doc.previous_version = docname

    for row in source.documents:
        new_doc.append("documents", {
            "document_type": row.document_type,
            "attachment": row.attachment,
        })

    for row in source.approval_matrix:
        new_doc.append("approval_matrix", {
            "role": row.role,
            "approver": row.approver,
            "status": "",
            "action_on": None,
            "remarks": None,
        })

    new_doc.insert(ignore_permissions=True)
    frappe.db.commit()

    return new_doc.name


def _notify_approver(doc, row):
    """Email the pending approver asking them to review."""
    link = get_url_to_form("JPL Project Approval Request", doc.name)
    requester_full = frappe.db.get_value("User", doc.owner, "full_name") or doc.owner
    approver_full = frappe.db.get_value("User", row.approver, "full_name") or row.approver

    subject = f"Action Required: Approve {doc.name} (v{doc.version})"
    message = f"""
        <p>Dear {approver_full},</p>
        <p>
            A project approval request has been submitted and requires your review
            as <strong>{row.role}</strong>.
        </p>
        <table style="border-collapse:collapse; font-size:13px; margin:16px 0;">
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Project</td>
                <td style="padding:4px 0;"><strong>{doc.project_name}</strong></td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Version</td>
                <td style="padding:4px 0;">{doc.version}</td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Submitted by</td>
                <td style="padding:4px 0;">{requester_full}</td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Reference</td>
                <td style="padding:4px 0;">{doc.name}</td>
            </tr>
        </table>
        <p>
            <a href="{link}" style="
                display:inline-block; padding:8px 20px;
                background:#4f9cf9; color:#fff; border-radius:6px;
                text-decoration:none; font-size:13px; font-weight:600;
            ">Review Request</a>
        </p>
        <p style="color:#6b7280; font-size:12px;">
            You can approve or reject directly from the record linked above.
        </p>
    """

    frappe.sendmail(
        recipients=[row.approver],
        subject=subject,
        message=message,
        now=True,
    )


def _notify_owner_rejection(doc, row):
    """Email the document owner and all previously-approved approvers when an approver rejects."""
    link = get_url_to_form("JPL Project Approval Request", doc.name)
    approver_full = frappe.db.get_value("User", row.approver, "full_name") or row.approver
    owner_full = frappe.db.get_value("User", doc.owner, "full_name") or doc.owner

    rejection_table = f"""
        <table style="border-collapse:collapse; font-size:13px; margin:16px 0;">
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Project</td>
                <td style="padding:4px 0;"><strong>{doc.project_name}</strong></td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Version</td>
                <td style="padding:4px 0;">{doc.version}</td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Rejected by</td>
                <td style="padding:4px 0;">{approver_full} ({row.role})</td>
            </tr>
            <tr>
                <td style="padding:4px 12px 4px 0; color:#6b7280;">Reason</td>
                <td style="padding:4px 0;">{frappe.utils.escape_html(row.remarks or "")}</td>
            </tr>
        </table>"""

    open_btn = f"""
        <p>
            <a href="{link}" style="
                display:inline-block; padding:8px 20px;
                background:#4f9cf9; color:#fff; border-radius:6px;
                text-decoration:none; font-size:13px; font-weight:600;
            ">Open Request</a>
        </p>"""

    # Notify the owner — action required
    frappe.sendmail(
        recipients=[doc.owner],
        subject=f"Rejected: {doc.name} — Action Required",
        message=f"""
            <p>Dear {owner_full},</p>
            <p>
                Your approval request <strong>{doc.name}</strong> has been
                <span style="color:#ef4444; font-weight:600;">rejected</span>
                by <strong>{approver_full}</strong> ({row.role}).
            </p>
            {rejection_table}
            <p>Please review the feedback, make the necessary amendments, and resubmit.</p>
            {open_btn}
        """,
        now=True,
    )

    # Notify previously-approved approvers — informational only
    previously_approved = [
        r for r in doc.approval_matrix
        if r.status == "Approved" and r.approver != row.approver
    ]
    for approved_row in previously_approved:
        approved_full = frappe.db.get_value("User", approved_row.approver, "full_name") or approved_row.approver
        frappe.sendmail(
            recipients=[approved_row.approver],
            subject=f"FYI: {doc.name} Has Been Rejected",
            message=f"""
                <p>Dear {approved_full},</p>
                <p>
                    This is to inform you that approval request <strong>{doc.name}</strong>,
                    which you previously approved as <strong>{approved_row.role}</strong>,
                    has been <span style="color:#ef4444; font-weight:600;">rejected</span>
                    by <strong>{approver_full}</strong> ({row.role}).
                </p>
                {rejection_table}
                <p style="color:#6b7280; font-size:12px;">
                    No action is required from you at this time. The owner has been notified
                    to make amendments and resubmit.
                </p>
                {open_btn}
            """,
            now=True,
        )


@frappe.whitelist()
def submit_for_approval(docname):
    doc = frappe.get_doc("JPL Project Approval Request", docname)

    if not doc.approval_matrix:
        frappe.throw("Add at least one approver before submitting for approval.")

    for row in doc.approval_matrix:
        if not row.approver:
            frappe.throw(f"Approver is not set for role <b>{row.role}</b>.")
        row.status = ""
        row.action_on = None
        row.remarks = None

    # Only the first approver in sequence gets notified
    sorted_rows = sorted(doc.approval_matrix, key=lambda r: r.idx)
    sorted_rows[0].status = "Pending"
    doc.approval_status = f"Pending {sorted_rows[0].role} Approval"

    frappe.flags.from_approval_action = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    _notify_approver(doc, sorted_rows[0])

    return "submitted"


@frappe.whitelist()
def record_approval_action(docname, row_name, action, remarks=""):
    if action not in ("Approved", "Rejected"):
        frappe.throw("Invalid action.")

    doc = frappe.get_doc("JPL Project Approval Request", docname)
    current_user = frappe.session.user

    row = next((r for r in doc.approval_matrix if r.name == row_name), None)
    if not row:
        frappe.throw("Approval row not found.")

    if row.approver != current_user:
        frappe.throw("You are not authorised to act on this approval.")

    if row.status != "Pending":
        frappe.throw("This approval has already been actioned.")

    if action == "Rejected" and not remarks:
        frappe.throw("A reason is required when rejecting.")

    row.status = action
    row.action_on = now_datetime()
    row.remarks = remarks

    next_row = None
    if action == "Approved":
        # Advance to the next approver in sequence
        sorted_rows = sorted(doc.approval_matrix, key=lambda r: r.idx)
        current_pos = next(i for i, r in enumerate(sorted_rows) if r.name == row_name)
        if current_pos + 1 < len(sorted_rows):
            next_row = sorted_rows[current_pos + 1]
            next_row.status = "Pending"
            doc.approval_status = f"Pending {next_row.role} Approval"
        else:
            doc.approval_status = "Approved"
    elif action == "Rejected":
        doc.approval_status = f"Rejected by {row.role}"

    frappe.flags.from_approval_action = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    if action == "Approved" and next_row:
        _notify_approver(doc, next_row)
    elif action == "Approved" and not next_row:
        # All approvers have approved — submit the document
        doc.submit()
        frappe.db.commit()
    elif action == "Rejected":
        _notify_owner_rejection(doc, row)

    return action


@frappe.whitelist()
def save_review_comment(docname, document_type, comment):
    doc = frappe.get_doc("JPL Project Approval Request", docname)

    doc.append("review_comments", {
        "document_type": document_type,
        "comment": comment,
        "commented_by": frappe.session.user,
        "commented_on": now_datetime()
    })

    frappe.flags.from_approval_action = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"message": "Comment saved successfully"}
