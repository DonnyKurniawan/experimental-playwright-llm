import fs from "fs";
import path from "path";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import dotenv from "dotenv"; // to run this LLM locally. but if its on CI CD we should store this on GitHub Secrets and inject them into the workflow.
dotenv.config();

type TestType = "api" | "e2e";

const SWAGGER_PATH = path.resolve("docs/swagger.json");
const TEST_ROOT = path.resolve("tests");
const swagger = fs.readFileSync(SWAGGER_PATH, "utf-8");

//caching process
const CACHE_DIR = path.resolve(".cache");
const HASH_FILE = path.join(CACHE_DIR, "generation.hash");

function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isCacheValid(currentHash: string): boolean {
  if (!fs.existsSync(HASH_FILE)) return false;
  const saved = fs.readFileSync(HASH_FILE, "utf-8");
  return saved === currentHash;
}

function saveHash(currentHash: string): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(HASH_FILE, currentHash);
}

// prompting

const apiPrompt = `
Given this OpenAPI specification:
${swagger}

Generate Playwright API tests.

Rules:
1 Use @playwright/test
2 Use request.post('/checkout')
3 Assert response status is 200
4 Validate response contains "success"
5 Output ONLY valid TypeScript
`;

const e2ePrompt = `
Generate a Playwright E2E test for a checkout page.

User Flow:
1. Open the homepage at '/'
2. Fill in the checkout form
3. Submit the form
4. Validate successful checkout message

Form Fields & Validation Rules:
1 name: required text
2 email: must be a valid email format
3 cardNumber: must be exactly 16 digits and pass Luhn validation
4 expiryDate: valid future date (MM/YY)
5 cvv: 3 or 4 digit number
6 amount: USD format, can include decimals (e.g. 100.50)

Instructions:
1 Use @playwright/test
2 Use ONLY these selectors:
  input[name="name"]
  input[name="email"]
  input[name="cardNumber"]
  input[name="expiryDate"]
  input[name="cvv"]
  input[name="amount"]
  button[type="submit"]

3 Use realistic valid test data:
  email → test@example.com
  cardNumber → valid Luhn number (e.g. 4242424242424242)
  expiryDate → future date (e.g. 12/30)
  cvv → 123
  amount → 100.50

4 Do NOT use:
  a id selectors
  b class selectors
  c random waits or sleeps

5 After submit:
  a Assert success message is visible
  b Assert no validation error message is shown
  c Valid card number (Luhn check passed) shown
  d showing Payment processed successfully!
  e if it running not in production can be show the ignore email check regarding point above (at poin d)

6 Output ONLY valid TypeScript code
`;

// Fallback
function apiFallback(): string {
  return `
import { test, expect } from '@playwright/test';

test('checkout API', async ({ request }) => {
  const res = await request.post('/checkout', {
    data: {
      name: "donquixote doflamingo",
      address: "Dressrosa",
      email: "test@smile.com"
    }
  });

  expect(res.status()).toBe(200);

  const body = await res.json();
  expect(body).toHaveProperty('success');
});
`;
}

function e2eFallback(): string {
  return `
import { test, expect } from '@playwright/test';

test('checkout flow', async ({ page }) => {
  await page.goto('/');

  await page.fill('input[name="name"]', 'Gomu Gomu No Mi User');
  await page.fill('input[name="address"]', 'East Blue');
  await page.fill('input[name="email"]', 'test@imusamaaa.com');
  await page.click('button[type="submit"]');

  await expect(page.locator('text=Success')).toBeVisible();
});
`;
}

// Guardrail

function isValidTest(code: string): boolean {
  return (
    code.includes("test(") &&
    code.includes("expect(") &&
    code.length > 50
  );
}

// Helpers to make the output clean and able to consume from AI
function clean(code: string): string {
  return code.replace(/```typescript|```javascript|```/g, "");
}

// Save the file
function save(filePath: string, content: string): void {
  const full = path.join(TEST_ROOT, filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// summon LLM
async function callLLM(prompt: string, type: TestType): Promise<string> {
  // summon Gemini
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (text && isValidTest(text)) {
      console.log("SUCCESS! Generated with Gemini");
      return text;
    }

    throw new Error("Invalid Gemini output");
  } catch {
    console.log("ERROR! Gemini failed, trying OpenAI...");
  }

  // secondary bullet
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });

    const text = res.choices[0]?.message?.content || "";

    if (text && isValidTest(text)) {
      console.log("SUCCESS! Generated with OpenAI");
      return text;
    }

    throw new Error("Invalid OpenAI output");
  } catch {
    console.log("ERROR! OpenAI failed, using fallback...");
  }

  return type === "api" ? apiFallback() : e2eFallback();
}

// Main

async function main(): Promise<void> {
  // check cache here
  const combined = swagger + apiPrompt + e2ePrompt;
  const currentHash = hash(combined);

  if (isCacheValid(currentHash)) {
    console.log("CACHE HIT: skipping test generation");
    return;
  }
  console.log("CACHE MISS: generating new tests");

  const [apiRaw, e2eRaw] = await Promise.all([
  callLLM(apiPrompt, "api"),
  callLLM(e2ePrompt, "e2e")
  ]);

  // save cacher
  saveHash(currentHash);
}

main().catch((err: Error) => {
  console.error("Generation failed:", err.message);
  process.exit(1);
});