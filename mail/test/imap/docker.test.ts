/**
 * The provider contract and the IMAP scenarios against real servers in Docker: GreenMail and Dovecot,
 * pinned images, started here and removed afterwards. Without a working Docker the whole file is skipped
 * and says why. Set USUAL_MAIL_SKIP_DOCKER=1 to skip it on purpose.
 */
import { after, before, describe, test } from "node:test";
import { providerContract } from "../../src/testing/index.ts";
import { DOVECOT, GREENMAIL, dockerProblem, type Container } from "./docker.ts";
import { externalChangeScenarios } from "./scenarios.ts";

const problem = await dockerProblem();

if (problem) {
  test("IMAP against GreenMail and Dovecot in Docker", { skip: `Docker-backed IMAP tests skipped: ${problem}` }, () => {});
} else {
  for (const server of [GREENMAIL, DOVECOT]) {
    describe(server.name, () => {
      let container: Container | undefined;
      before(async () => {
        container = await server.start();
      });
      after(async () => {
        await container?.stop();
      });
      providerContract(server.name, () => server.harness(container!));
      externalChangeScenarios(server.name, (options) => server.harness(container!, options));
    });
  }
}
