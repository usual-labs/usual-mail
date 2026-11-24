// The one error a picture source throws for a picture it won't or can't give: its words say why, for a person.
//
// `refused`: the rules or the content refused it (an address, port or scheme never fetched from, too many
// redirects, a compressed or oversized answer, something that isn't a picture the server shows): asking again would
// give the same, so the source remembers it for good and serves it blank. `failed`: the site couldn't be reached or
// answered with an error, which may pass; the source tries again a limited number of times.

export type PictureRefusalKind = "refused" | "failed";

export class PictureRefused extends Error {
  override readonly name = "PictureRefused";
  readonly kind: PictureRefusalKind;

  constructor(message: string, kind: PictureRefusalKind = "failed") {
    super(message);
    this.kind = kind;
  }
}
