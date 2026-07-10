/**
 * Integration test: Verify Transbank refund HTTP behavior.
 *
 * This script calls the REAL Transbank integration API to determine:
 * 1. What HTTP status code does refund return when already processed?
 * 2. What does the response body look like?
 * 3. Does getTransactionStatus work as fallback after refund?
 *
 * Run: bun run scripts/test-refund-behavior.ts
 *
 * Uses Transbank's PUBLIC integration credentials (safe to commit).
 */

const COMMERCE_CODE = "597055555532";
const API_SECRET = "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C";
const BASE_URL = "https://webpay3gint.transbank.cl";
const API_PATH = "/rswebpaytransaction/api/webpay/v1.2/transactions";

const headers = {
  "Tbk-Api-Key-Id": COMMERCE_CODE,
  "Tbk-Api-Key-Secret": API_SECRET,
  "Content-Type": "application/json",
};

async function createTransaction(): Promise<string> {
  const buyOrder = `TEST-REFUND-${Date.now()}`;
  const response = await fetch(`${BASE_URL}${API_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      buy_order: buyOrder,
      session_id: "test-session",
      amount: 1000, // Small amount for testing
      return_url: "http://localhost:3000/return",
    }),
  });

  if (!response.ok) {
    throw new Error(`createTransaction failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  console.log(`✅ Transaction created: buyOrder=${buyOrder}, token=${data.token.substring(0, 20)}...`);
  return data.token;
}

async function commitTransaction(token: string): Promise<any> {
  const response = await fetch(`${BASE_URL}${API_PATH}/${token}`, {
    method: "PUT",
    headers,
  });

  const status = response.status;
  const body = await response.text();
  console.log(`\n📋 Commit response: HTTP ${status}`);
  console.log(`   Body: ${body}`);

  if (status === 422) {
    console.log(`   → HTTP 422 for commit (already processed)`);
  }

  return { status, body: JSON.parse(body) };
}

async function refundTransaction(token: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE_URL}${API_PATH}/${token}/refunds`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amount: 1000 }),
  });

  const status = response.status;
  const body = await response.text();
  console.log(`\n💰 Refund response: HTTP ${status}`);
  console.log(`   Body: ${body}`);

  return { status, body: JSON.parse(body) };
}

async function getTransactionStatus(token: string): Promise<any> {
  const response = await fetch(`${BASE_URL}${API_PATH}/${token}`, {
    method: "GET",
    headers,
  });

  const status = response.status;
  const body = await response.text();
  console.log(`\n🔍 Status response: HTTP ${status}`);
  console.log(`   Body: ${body}`);

  return { status, body: JSON.parse(body) };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Transbank Refund Behavior Test — Integration API");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    // Step 1: Create a transaction
    console.log("Step 1: Creating transaction...");
    const token = await createTransaction();

    // Step 2: Commit it (simulate payment)
    console.log("\nStep 2: Committing transaction (simulating payment)...");
    const commitResult = await commitTransaction(token);

    // Step 3: First refund (should succeed)
    console.log("\nStep 3: First refund (should succeed)...");
    const refund1 = await refundTransaction(token);

    // Step 4: Second refund on same token (should fail — this is the key test)
    console.log("\nStep 4: Second refund on same token (should fail)...");
    const refund2 = await refundTransaction(token);

    // Step 5: Check status after refunds
    console.log("\nStep 5: Checking transaction status after refunds...");
    const statusAfter = await getTransactionStatus(token);

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  SUMMARY");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Commit HTTP status:     ${commitResult.status}`);
    console.log(`  First refund HTTP:      ${refund1.status}`);
    console.log(`  Second refund HTTP:     ${refund2.status}`);
    console.log(`  Status after refunds:   ${statusAfter.body?.status}`);
    console.log("");

    if (refund2.status === 422) {
      console.log("  ✅ CONCLUSION: Transbank returns HTTP 422 for already-processed refund");
      console.log("     → Our commitTransaction pattern (check 422) applies to refund too");
    } else if (refund2.status === 200 && refund2.body?.response_code === 310) {
      console.log("  ✅ CONCLUSION: Transbank returns HTTP 200 with response_code 310");
      console.log("     → We need to check response_code in body, NOT HTTP status");
    } else if (refund2.status === 200 && refund2.body?.response_code !== 0) {
      console.log(`  ✅ CONCLUSION: Transbank returns HTTP 200 with response_code ${refund2.body?.response_code}`);
      console.log("     → We need to check response_code in body for error detection");
    } else {
      console.log(`  ⚠️  UNEXPECTED: HTTP ${refund2.status} with body: ${JSON.stringify(refund2.body)}`);
    }

  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
