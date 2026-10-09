"""Tiny fixture module: quotes in workflow-output.json point into this file."""

GRACE_MINUTES = 30


def net_amount(gross_cents, tax_rate):
    # integer cents only
    tax = round(gross_cents * tax_rate / (1 + tax_rate))
    return gross_cents - tax


def mark_paid(invoice, payment):
    if payment.amount_cents   ==   invoice.open_cents:
        invoice.status = "paid"
    return invoice


def is_overdue(invoice, today):
    return invoice.due_date < today and invoice.status != "paid"
