#!/usr/bin/env python3
"""Mosshatch Phase 0 unit-economics model (analysis script, not application code).

Every input is either (V) verified in docs/research/* with a URL and date, or
(A) an assumption that is labelled as such and can be changed below.
Money is computed with Decimal. Run:  python3 unit_economics.py
"""
from decimal import Decimal as D, ROUND_HALF_UP
import itertools, json, sys

def q(x): return x.quantize(D("0.01"), rounding=ROUND_HALF_UP)

# ---- Stripe (V: docs/research/stripe-fees.md, stripe.com/pricing, 2026-09-29) ----
STRIPE_PCT   = D("0.029")
STRIPE_FIXED = D("0.30")
INTL_PCT     = D("0.015")     # international card surcharge
DISPUTE_RECEIVED = D("15.00") # never returned
DISPUTE_COUNTER  = D("15.00") # returned only on a win
TAX_PCT_WHERE_REGISTERED = D("0.005")  # Stripe Tax Basic (Checkout), V

# ---- Wholesale (V: OpenSRS Essential rate card; effective-dated changes page, 2026-09-29) ----
# Register = renew = transfer for the standard (non-promo) price; .ai has a 2-year minimum.
WHOLESALE = {
    "opensrs_essential": {   # values effective 2026-11-01 (.com) and 2026-10-06 (.studio)
        "com": D("15.25"), "ai": D("111.00"), "dev": D("17.00"),
        "io": D("60.00"),  "app": D("21.00"), "studio": D("51.00"),
    },
    "dynadot_list": {        # V: dynadot dossier, public list, renew prices (promos excluded)
        "com": D("10.88"), "ai": D("85.60"), "dev": D("12.50"),
        "io": D("53.50"),  "app": D("14.50"), "studio": D("33.39"),
    },
}
MIN_YEARS = {"ai": 2}   # V: registry minimum term

# ---- Behavioural assumptions (A: no published base rate; flagged in the plan) ----
A = dict(
    intl_share=D("0.15"),        # share of orders on international cards
    refund_rate_first=D("0.03"), # customer cancels inside the add-grace window
    refund_rate_renew=D("0.005"),
    fail_rate=D("0.01"),         # registration fails after authorization: void, no Stripe fee
    dispute_rate_first=D("0.005"),
    dispute_rate_renew=D("0.010"),
    dispute_loss_share=D("0.70"),  # share of disputes lost after countering
    support_cost_refund=D("1.50"),
    support_cost_dispute=D("5.00"),
    support_cost_fail=D("2.00"),
    # Upstream refund on cancel: fraction of W recovered. gTLD add-grace refunds exist
    # (AGP), capped by the AGP Limits Policy; ccTLDs .ai/.io are non-refundable (V).
    agp_recovery={"com": D("0.9"), "dev": D("0.9"), "app": D("0.9"), "studio": D("0.9"),
                  "io": D("0"), "ai": D("0")},
    renewal_refund_recovers_W=D("0"),  # V: OpenSRS "A renewal transaction is final"
    tax_registered_share=D("0"),       # launch US-only, no registrations yet (A)
    funding_grossup=D("0"),            # OpenSRS deposits by ACH/wire assumed; card/PayPal = 1/0.97 - 1 (V: payment-terms)
)

def stripe_fee(total, intl):
    f = STRIPE_PCT * total + STRIPE_FIXED
    if intl: f += INTL_PCT * total
    return f

def expected_contribution(tld, F, W_per_year, years, renewal=False):
    """Expected contribution (USD) of one order of `years` years at flat fee F per year."""
    W = W_per_year * years
    Fee = F * years
    T = W + Fee
    s_dom = stripe_fee(T, False); s_int = stripe_fee(T, True)
    S = (1 - A["intl_share"]) * s_dom + A["intl_share"] * s_int
    tax_cost = A["tax_registered_share"] * TAX_PCT_WHERE_REGISTERED * T
    r = A["refund_rate_renew"] if renewal else A["refund_rate_first"]
    d = A["dispute_rate_renew"] if renewal else A["dispute_rate_first"]
    f = D("0") if renewal else A["fail_rate"]
    rec = A["renewal_refund_recovers_W"] if renewal else A["agp_recovery"][tld]
    ok = D("1") - r - d - f
    fund = W * A["funding_grossup"]    # deposit fee on wholesale actually spent
    c_ok      = Fee - S - tax_cost - fund
    c_refund  = -S - (1 - rec) * W - A["support_cost_refund"] - fund
    c_fail    = -A["support_cost_fail"]
    c_lost    = -W - S - DISPUTE_RECEIVED - DISPUTE_COUNTER - A["support_cost_dispute"] - fund
    c_won     = Fee - S - DISPUTE_RECEIVED - A["support_cost_dispute"] - fund
    c_disp    = A["dispute_loss_share"] * c_lost + (1 - A["dispute_loss_share"]) * c_won
    exp = ok * c_ok + r * c_refund + f * c_fail + d * c_disp
    return dict(total=T, stripe=S, per_year=exp / years, c_ok=c_ok / years)

def breakeven_fee(tld, W_per_year, years, target, renewal=False):
    F = D("0.00")
    while F < D("60"):
        if expected_contribution(tld, F, W_per_year, years, renewal)["per_year"] >= target:
            return F
        F += D("0.25")
    return None


def sensitivity():
    import copy
    global A
    base = copy.deepcopy(A)
    print("## Sensitivity: expected contribution per domain-year at OpenSRS Essential wholesale\n")
    print("Each row changes one assumption from the base case; F is $4.00 for .com and .app, $9.00 for .studio and .io, $10.00 for .ai.\n")
    cases = [
        ("base case", {}),
        ("disputes 0.25% (first) / 0.5% (renewal)", dict(dispute_rate_first=D("0.0025"), dispute_rate_renew=D("0.005"))),
        ("disputes 1.0% / 2.0%", dict(dispute_rate_first=D("0.010"), dispute_rate_renew=D("0.020"))),
        ("disputes 2.0% / 3.0% (Stripe risk review would intervene)", dict(dispute_rate_first=D("0.020"), dispute_rate_renew=D("0.030"))),
        ("refunds 8% of first orders", dict(refund_rate_first=D("0.08"))),
        ("all cards international (share 100%)", dict(intl_share=D("1.0"))),
        ("Stripe Tax on every order (0.5%)", dict(tax_registered_share=D("1.0"))),
        ("no upstream refund on cancel (AGP pool exhausted)", dict(agp_recovery={k: D("0") for k in A["agp_recovery"]})),
        ("wholesale deposits funded by card or PayPal (+3.09% of wholesale)", dict(funding_grossup=(D("1")/D("0.97") - D("1")))),
    ]
    table = WHOLESALE["opensrs_essential"]
    picks = [("com", D("4.00")), ("app", D("4.00")), ("studio", D("9.00")), ("io", D("9.00")), ("ai", D("10.00"))]
    print("| case | " + " | ".join(f".{t} (F=${f})" for t, f in picks) + " |")
    print("|---|" + "---|" * len(picks))
    for name, patch in cases:
        A = copy.deepcopy(base); A.update(patch)
        cells = []
        for tld, F in picks:
            y = MIN_YEARS.get(tld, 1)
            cells.append(str(q(expected_contribution(tld, F, table[tld], y)["per_year"])))
        print(f"| {name} | " + " | ".join(cells) + " |")
    A = base
    print()

def renewals():
    print("## Renewal-cycle contribution per domain-year (renewal order, one year)\n")
    print("| TLD | wholesale | F | customer pays | Stripe fee | expected contribution |")
    print("|---|---|---|---|---|---|")
    table = WHOLESALE["opensrs_essential"]
    for tld, F in [("com", D("4.00")), ("dev", D("4.00")), ("app", D("4.00")), ("studio", D("9.00")), ("io", D("9.00")), ("ai", D("10.00"))]:
        y = 2 if tld == "ai" else 1   # .ai renews in 2-year units at OpenSRS (V)
        r = expected_contribution(tld, F, table[tld], y, renewal=True)
        print(f"| .{tld} | {table[tld]*y} | {F*y} | {q(r['total'])} | {q(r['stripe'])} | {q(r['per_year']*y)} per {y} yr |")
    print()

def main():
    out = {}
    print("## Expected contribution per domain-year (USD), first order, by flat fee F\n")
    Fs = [D(x) for x in ("2.00", "3.00", "4.00", "5.00", "6.00", "8.00", "10.00", "12.00")]
    for route, table in WHOLESALE.items():
        print(f"### Route: {route}\n")
        print("| TLD | years | wholesale/yr | " + " | ".join(f"F=${f}" for f in Fs) + " |")
        print("|---|---|---|" + "---|" * len(Fs))
        for tld, W in table.items():
            y = MIN_YEARS.get(tld, 1)
            row = [str(q(expected_contribution(tld, F, W, y)["per_year"])) for F in Fs]
            print(f"| .{tld} | {y} | {W} | " + " | ".join(row) + " |")
        print()
    print("## Price the customer sees (wholesale + F, first order total, before tax)\n")
    for route, table in WHOLESALE.items():
        print(f"### {route}, F=$4.00 and F=$6.00\n")
        print("| TLD | order years | wholesale | total at F=$4 | per year | total at F=$6 |")
        print("|---|---|---|---|---|---|")
        for tld, W in table.items():
            y = MIN_YEARS.get(tld, 1)
            print(f"| .{tld} | {y} | {q(W*y)} | {q(W*y+4*y)} | {q(W+4)} | {q(W*y+6*y)} |")
        print()
    print("## Break-even flat fee for a target expected contribution per domain-year\n")
    for route, table in WHOLESALE.items():
        for target in (D("0.00"), D("1.50"), D("2.50")):
            print(f"### {route}: expected contribution >= ${target}/domain-year\n")
            print("| TLD | first order F* | renewal F* |")
            print("|---|---|---|")
            for tld, W in table.items():
                y = MIN_YEARS.get(tld, 1)
                a = breakeven_fee(tld, W, y, target)
                b = breakeven_fee(tld, W, MIN_YEARS.get(tld, 1), target, renewal=True)
                print(f"| .{tld} | {a} | {b} |")
            print()
    print("## Stripe cost on a single domestic card order (first order, no refund)\n")
    print("| total | Stripe fee | % of total |")
    print("|---|---|---|")
    for t in ("15.00", "20.00", "25.00", "60.00", "115.00", "226.00"):
        T = D(t); s = stripe_fee(T, False)
        print(f"| ${t} | ${q(s)} | {q(s/T*100)}% |")
    print()
    sensitivity()
    renewals()
    print("## Monthly fixed-cost scenarios and break-even volume\n")
    fixed = {
        "recommended path (Vercel Pro 20, Static IPs 100, Neon Scale 42 to 45, Resend Pro 20, KMS 4, domains and monitoring 15)":
            (D("20")+D("100")+D("42")+D("20")+D("4")+D("15"), D("20")+D("100")+D("45")+D("20")+D("4")+D("15")),
        "gateway path (Vercel Pro 20, Neon Scale 42 to 45, Resend Free, KMS 4, gateway 6, domains and monitoring 15)":
            (D("20")+D("42")+D("0")+D("4")+D("6")+D("15"), D("20")+D("45")+D("0")+D("4")+D("6")+D("15")),
    }
    for name, (lo, hi) in fixed.items():
        print(f"- {name}: about ${lo} to ${hi}/month (Neon Scale = always-on 0.25 CU: 187.5 CU-h x $0.222 = $41.63 plus storage; Neon, gateway and monitoring are our own estimates; Private Data Transfer on Static IPs is extra)")
    print()
    print("| scenario | fixed $/mo | expected contribution per domain-year | domain-years/month to break even |")
    print("|---|---|---|---|")
    for label, (lo, hi) in [("recommended", list(fixed.values())[0]), ("gateway", list(fixed.values())[1])]:
        for c in (D("1.50"), D("2.50"), D("3.00")):
            a = int((lo / c).to_integral_value(rounding='ROUND_CEILING')); b = int((hi / c).to_integral_value(rounding='ROUND_CEILING'))
            print(f"| {label} | {lo} to {hi} | {c} | {a} to {b} |")
    print()
    print("## Premium-priced names (why they are not sold at launch)\n")
    for W_, F_ in ((D("108.90"), D("4.00")),):
        r = expected_contribution("app", F_, W_, 1, renewal=True)
        print(f"- A renewal at wholesale ${W_} with the standard fee ${F_}: customer pays ${q(r['total'])}, expected contribution ${q(r['per_year'])} per domain-year.")

if __name__ == "__main__":
    main()
