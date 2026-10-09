"""Invoice totals for the integration fixture."""
from decimal import Decimal

VAT_RATE = Decimal("0.20")


def net_from_gross(gross):
    vat = gross * VAT_RATE / (1 + VAT_RATE)
    return gross - vat


def apply_discount(total, pct):
    if pct > 100:
        raise ValueError("discount above 100%")
    return total - total * pct / 100


def is_overdue(invoice, today):
    return invoice.due_date <= today
