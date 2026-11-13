#!/usr/bin/env node
import { existsSync } from "node:fs";
import { main } from "../src/cli/main.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const code = await main(process.argv.slice(2), process.env);
process.exitCode = code;
