// ISO 4217's active currency codes and their minor units (the digits after the decimal point), as the standard lists
// them, so a receipt's amount is kept in exactly the minor units ISO gives. The JavaScript runtime's own figures follow
// CLDR, which differs for some (it says 0 for LAK, MGA and HUF, 0 for IQD, and 2 for gold), so they are not used.
// Funds codes without minor units in ISO (gold, silver, the SDR, testing codes) are left out: an amount in a code not
// listed here is dropped rather than guessed. Every code not named in a list below has two minor units.

const ZERO = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"];
const THREE = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const FOUR = ["CLF", "UYW"];
const TWO = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BMD", "BND", "BOB",
  "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CNY", "COP", "COU", "CRC", "CUP",
  "CVE", "CZK", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GTQ",
  "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IRR", "JMD", "KES", "KGS", "KHR", "KPW", "KYD", "KZT", "LAK",
  "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV",
  "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR", "RON", "RSD",
  "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "USD", "USN", "UYU", "UZS", "VED", "VES", "WST", "XCD",
  "XCG", "YER", "ZAR", "ZMW", "ZWG", "ZWL",
];

/** Each listed code's minor units. */
export const ISO_4217_MINOR_UNITS: ReadonlyMap<string, number> = new Map([
  ...ZERO.map((code) => [code, 0] as const),
  ...TWO.map((code) => [code, 2] as const),
  ...THREE.map((code) => [code, 3] as const),
  ...FOUR.map((code) => [code, 4] as const),
]);

/** A code's minor units, or null for a code ISO 4217 doesn't list with them. */
export function minorUnits(code: string): number | null {
  return ISO_4217_MINOR_UNITS.get(code) ?? null;
}
