# Contributing to Usual Mail

Usual Mail is early (0.1.0 is its first release). Its contributor agreement
([CLA.md](CLA.md)) is still a **draft without a legal review**, so pull requests can't be merged until it is final.
Issues and discussion are welcome now.

## Before you start

- Read [AGENTS.md](AGENTS.md) and [docs/contract.md](docs/contract.md): how the parts fit together and the rules
  every part follows. Each part has its own note in [docs/agents/](docs/agents/); read the one for the part you
  change and update it in the same change.
- Open an issue first for anything bigger than a small fix, so we can agree on the shape before you build it.
- Run the checks of each part you change; [docs/agents/01-overview.md](docs/agents/01-overview.md) ("Checks") lists
  them. Type checks, tests and builds are the checks.

## Rules that matter for every change

- No real mailboxes, accounts, keys or tokens in code, tests, fixtures or notes. Sample addresses end in `.example`.
- Keep files under about 500 lines, split by responsibility.
- Say what is built and what isn't; don't describe a plan as if it were done.

## Work that isn't yours

Don't add code, icons, fonts, pictures or data from elsewhere unless its licence lets it be distributed with
Usual Mail under the AGPL-3.0. Name it in your pull request (where it comes from, its author and licence), add it to
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and put its licence text beside it. Icons come from Hugeicons' free
set only, never its Pro set. Apple's SF Symbols may be used in the Apple apps only. If you didn't write something you
submit, say so; don't submit it as your own.

## Licence

Usual Mail is licensed under the [GNU Affero General Public License, version 3 only](LICENSE). Your contributions are
published under that licence.

## The contributor agreement

Before a contribution can be merged, its author agrees to Usual Mail's contributor agreement ([CLA.md](CLA.md)). In
short:

- You keep the copyright in what you contribute.
- You give the maker of Usual Mail a licence to use it, including the right to publish it under other terms as well
  as the AGPL, for example in the App Store.
- In return, your contribution also stays available under the licence Usual Mail used when you contributed it.

Once the agreement is final (version 0.1 is a draft, not in force, and `CLA.md` says so at the top), you agree by
writing this in the description of your first pull request, from your own account, with the final version's number
in place of 0.1:

> I have read the Usual Mail Individual Contributor License Agreement, version 0.1, in CLA.md, and I agree to it for
> this and all my future contributions to Usual Mail.

Until then, don't agree to the draft.

If your employer may own what you write, ask them first. The agreement for companies isn't written yet; open an
issue if you need it.

## Security

Please don't report a security problem in a public issue. Write to hello@usual.dev instead.
