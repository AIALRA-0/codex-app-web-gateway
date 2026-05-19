#!/usr/bin/env node
"use strict";

const patterns = [
  "Aialra040311",
  "22aialra22",
  "codex\\.aialra\\.online",
  "opencode\\.aialra\\.online",
  "/srv/aialra",
  "/home/aialra",
  "\"refresh_token\"",
  "\"access_token\"",
  "BEGIN [A-Z ]*PRIVATE KEY",
  "OPENAI_API_KEY\\s*=",
  "sk-[A-Za-z0-9_-]{20,}",
  "github_pat_[A-Za-z0-9_]+",
  "ghp_[A-Za-z0-9_]{20,}",
  "xox[baprs]-[A-Za-z0-9-]+",
];

process.stdout.write(`${patterns.join("\n")}\n`);
