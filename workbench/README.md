# Workbench host fork

English | [中文](README.zh.md)

This public fork preserves official Git ancestry. `workbench` is the maintained branch; `upstream` points to deepseek-ai/deepseek-harness. The accepted import base is dsh-v0.1.5-rc.1 (183f08e9c6dde7e36cd2318eaee70b0da08fb35e). Import provenance and changed files are recorded in compatibility.json. New upstream revisions are candidates, not automatic production upgrades.

## Agent rules

Start a codex/<task> branch and open one focused PR. Read AGENTS.md and the two DSH testing skills. Confirm the available commands, installed Git hooks and runner environment before relying on them. Ordinary Git/PR workflows do not require gh-stack. Follow the upstream minimal local checks policy; missing hooks require explicit typecheck. Do not force-push shared branches, drop local features to resolve conflicts, or weaken tests to make a sync green.

Every upstream sync inventories local patches as retained, superseded by an equivalent upstream implementation, adapted or blocked. Attach behavior evidence before retiring a patch. Changes to dependency versions, Session formats, auth, lifecycle, public APIs and the patch surface require explicit compatibility review. Keep the public repository free of private plugins, user sessions, credentials and local deployment records.

The post-build seam step is a temporary source-controlled bridge for two legacy compiled-only patches: optional restart admission and optional image relay. It operates exclusively on this checkout's built files, rejects unknown shapes and does not touch installed runtimes. Agents must preserve and test these behaviors during upgrades; moving them into typed source APIs is a separate reviewed change.

## CI and sync

Fork CI uses GitHub-hosted Ubuntu, builds the full project, checks types and runs unit tests. It also tests and applies the two legacy seams. The upstream enterprise workflows are retained as references but disabled in this fork; they cannot be assumed runnable on personal-account runners. No job publishes npm or deploys a production host.

Upstream sync runs daily at 02:23 UTC (10:23 Asia/Shanghai) and on manual dispatch. A trusted script queries official master, creates a uniquely named candidate branch and asks the GitHub merge API to merge that exact upstream SHA. Clean merges produce a draft PR and explicitly dispatch Fork CI. Conflicts produce a deduplicated agent task Issue; no force reset or conflict-marker commit is published. Existing candidates are not overwritten. The job executes no candidate code with its write token.

An external agent executor is not yet configured. The Issue/PR is the handoff contract, not a claim that an AI has repaired the change. A selected executor may pick up these tasks with repository-scoped credentials and follow these rules. Keep merge review with the owner until an explicit auto-merge policy is approved.

GITHUB_TOKEN-triggered PR checks may need approval under GitHub policy. Explicit workflow_dispatch supplies test feedback but does not substitute for required PR checks. Confirm checks on the current PR revision before merging.

## Acceptance and release

A passing host CI is not full plugin compatibility. The private plugin repository must test the same candidate commit and preserve its pinned dependency baseline until a reviewed compatibility PR updates it. Verify Host/Client loading, UI entries, Sessions, attachments and each version-sensitive patch. Record missing evidence explicitly. A fresh build of this fork is a candidate and is not claimed byte-identical to the installed runtime.

The production service, Profile, signing material, saved sessions and model routes are outside Actions scope. They require separate deployment approval and rollback planning.
