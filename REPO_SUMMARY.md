# dsh-superagent-prototype Repository Summary

## Overview

This repository, `jonsutton86/dsh-superagent-prototype`, is described as:

> "Towards a More Autonomous Agent System"

It is a TypeScript-based research prototype for a proactive coding agent designed to work within a single GitHub repository. The project is packaged as a bundle for DeepSeek Harness and is focused on autonomous repository-aware agent behavior, policy enforcement, execution, and deployment.

Language composition:
- TypeScript: 97.5%
- CSS: 1.9%
- Python: 0.6%

## Purpose

The codebase presents a system for an autonomous coding agent that:
- listens to repository events such as GitHub activity
- optionally integrates with Feishu-based workflows
- evaluates requests under a policy layer
- authorizes actions before execution
- performs work within a scoped workspace
- supports deployment and operational setup for real use

In short, this is not just a library—it is a full agent runtime and operational framework for autonomous software work.

## High-level architecture

The repo is organized around a layered design:

- `src/app` — application-level orchestration and app behavior
- `src/client` — client-facing integration and UI-related functionality
- `src/core` — shared core logic and system primitives
- `src/executor` — action execution and task-running logic
- `src/infra` — infrastructure and supporting runtime services
- `src/sources` — sources and integrations for external inputs

Key files at the root include:
- `src/index.ts` — main entry point
- `src/setup.ts` — setup flow
- `src/policy.ts` — policy and authorization logic
- `src/deployment.ts` — deployment and runtime configuration
- `src/admission.ts` — admission/approval flow
- `src/navigation.ts` — navigation logic
- `src/kv.ts` — key-value storage helper or runtime state store
- `src/limits.ts` — system or action constraints

## Project structure

### Root-level files
- `README.md` — project overview and usage guidance
- `SETUP.md` — detailed environment and installation instructions
- `package.json` — package metadata, scripts, and dependency configuration
- `tsconfig.json` — TypeScript compiler config
- `tsdown.config.ts` — build configuration
- `vitest.config.ts` — test configuration
- `cordis.patch.yml` — patch configuration for the DSH bundle
- `LICENSE` — MIT license
- `pnpm-lock.yaml` — lockfile for pnpm

### Documentation and knowledge assets
- `docs/` — numbered design and architecture documentation
- `examples/` — example usage or example workflows
- `prompts/` — prompt templates or policy prompts
- `skills/` — reusable skill definitions or task modules
- `scripts/` — operational scripts
- `locale/` — localization JSON content
- `tests/` — automated tests

## Runtime and build system

The project is a Node-based TypeScript package using:
- `pnpm` as the package manager
- `tsdown` for building
- `vitest` for testing
- `TypeScript 6` and Node 22+/24

Relevant scripts in `package.json`:
- `pnpm build` → build the package
- `pnpm test` → run tests
- `pnpm typecheck` → validate TypeScript types
- `pnpm check` → run typecheck, tests, and build

## Repository intent

This repository appears to be a research/prototype implementation of a highly autonomous software agent system. It is designed to reduce human attention while increasing the value of machine-executed repository work. The emphasis is on:
- autonomous planning
- authorization and safety policies
- scoped execution over specific repos
- deployment-ready agent packaging
- documentation-first architecture for research and operational use

## Summary

`dsh-superagent-prototype` is a TypeScript research project for building a repository-aware, autonomous software agent framework. Its architecture centers on policy-controlled execution, deployment scaffolding, and integration with GitHub and other external systems. It is more of a complete agent platform prototype than a conventional app, with substantial emphasis on system design, documentation, and autonomous operating behavior.

## Suggested next read

If you want to understand the repo quickly, read these in order:
1. `README.md`
2. `SETUP.md`
3. `docs/000-philosophy.md`
4. `docs/001-domain.md`
5. `docs/007-architecture.md`

This sequence gives the clearest overview of the project’s purpose, operating model, and system design.
