// The payment services, resellers and wallets that only handle a payment for someone else: the one list both the
// details request's words (prompt.ts) and the server's party rules (payment-party.ts) use. Each with the label its
// senders' addresses carry ("paypal" in service@paypal.de).

export const PAYMENT_SERVICE_LIST: ReadonlyArray<{ name: string; label: string }> = [
  { name: "PayPal", label: "paypal" },
  { name: "Stripe", label: "stripe" },
  { name: "Klarna", label: "klarna" },
  { name: "Adyen", label: "adyen" },
  { name: "Paddle", label: "paddle" },
  { name: "FastSpring", label: "fastspring" },
  { name: "Apple Pay", label: "apple" },
  { name: "Google Pay", label: "google" },
];

/** Whether an address is a payment service's: its domain has one of the list's labels ("mail.paypal.de"). */
export function isPaymentService(address: string): boolean {
  const labels = (address.split("@")[1] ?? "").toLowerCase().split(".");
  return PAYMENT_SERVICE_LIST.some((service) => labels.includes(service.label));
}
