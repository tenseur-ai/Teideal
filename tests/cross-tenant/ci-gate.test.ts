// TEID-41-T3 (Functional): a release that fails the cross-tenant suite is
// blocked from deployment. The suite failing red is exercised by CI itself
// on every push (that's what "on every release" means); what this test
// checks, automatically and on every run, is that the pipeline is actually
// wired so a red test job blocks the deploy job -- i.e. that the gate
// cannot silently rot into a no-op (a deploy job with no `needs`, or with
// `continue-on-error: true`, would defeat AC3 even though the tests
// themselves still ran and failed).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(repoRoot, ".github/workflows/ci.yml");

describe("TEID-41-T3: CI gate blocks deployment on suite failure", () => {
  const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));

  it("has a job that runs the cross-tenant suite", () => {
    const jobs = Object.entries(workflow.jobs as Record<string, any>);
    const testJob = jobs.find(([, def]) =>
      JSON.stringify(def).includes("tests/cross-tenant"),
    );
    expect(testJob, "expected a job invoking tests/cross-tenant").toBeTruthy();
  });

  it("the deploy job depends on the test job succeeding, and does not ignore its failure", () => {
    const jobs = workflow.jobs as Record<string, any>;
    const deployJob = jobs.deploy;
    expect(deployJob, "expected a job named `deploy`").toBeTruthy();

    const needs = Array.isArray(deployJob.needs) ? deployJob.needs : [deployJob.needs];
    expect(needs).toContain("test");

    // continue-on-error on the test job, or on any of its steps, would let
    // a red suite pass through anyway -- explicitly forbidden.
    expect(jobs.test["continue-on-error"]).not.toBe(true);
    for (const step of jobs.test.steps ?? []) {
      expect(step["continue-on-error"]).not.toBe(true);
    }
  });
});
