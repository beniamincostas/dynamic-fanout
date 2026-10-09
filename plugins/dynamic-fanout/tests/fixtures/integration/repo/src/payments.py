"""Payment matching for the integration fixture."""

TOLERANCE_CENTS = 0


def match(payment, invoices):
    for inv in invoices:
        if payment.reference == inv.number:
            return inv
    return None


def settle(payment, invoice):
    invoice.open_cents -= payment.amount_cents
    if invoice.open_cents < 0:
        invoice.status = "overpaid"
    return invoice
