// deno-lint-ignore-file require-await no-explicit-any prefer-const
// @ts-ignore
import { Clarinet, Tx, Chain, Account, types, assertEquals, pricePackageToCV, assertStringIncludes, assertMatch, hex2ascii, shiftPriceValue } from "./deps.ts";
// @ts-ignore
import { PricePackage, Block, getIntValueFromPrintOutput, getStringValueFromPrintOutput } from "./deps.ts";

// Unfortunately it is not straightforward to import "../src/stacks-redstone.ts"
// in Clarinet test files. Values are therefore generated by the helper scripts
// found in the ./scripts directory. The parameters used to generate the data
// is provided in comments.

// TODO: Tests to write:
// - user tries to close without repaying borrowed amount
// - user can close if he hasnt borrowed
// - borrow without collateral/funded state fails
// - repay more then borrowed amount
// - repay fails with proper error message on negative balance

const BTChex = "BTC";
const UUID = "fakeuuid";
const nftAssetContract = "open-dlc";
const dlcManagerContract = "dlc-manager-priced-v0-1";
const sampleProtocolContract = "sample-contract-loan-v0-1";

const contractPrincipal = (deployer: Account, contract: string) => `${deployer.address}.${contract}`;

const trustedOraclePubkey = "0x035ca791fed34bf9e9d54c0ce4b9626e1382cf13daa46aa58b657389c24a751cc6";
const untrustedOraclePubkey = "0x03cd2cfdbd2ad9332828a7a13ef62cb999e063421c708e863a7ffed71fb61c88c9";

const pricePackage: PricePackage = {
  timestamp: 1647332581,
  prices: [{ symbol: "BTC", value: 23501.669932 }]
}

const pricePackageForLiquidation: PricePackage = {
  timestamp: 1647332581,
  prices: [{ symbol: "BTC", value: 13588.669932 }]
}

const packageCV = pricePackageToCV(pricePackage);
const packageCVForLiquidation = pricePackageToCV(pricePackageForLiquidation);

const signature = "0x4ee83f2bdc6d67619e13c5786c42aa66a899cc63229310400247bac0dd22e99454cec834a98b56a5042bcec5e709a76e90d072569e5db855e58e4381d0adb0c201";

const signatureForLiquidation = "0x3256910f5d0788ee308baecd3787a36ab2e3a8ff3fb4d0fc4638c84ba48957b82876b71eb58751366dd7a8a6ae1f2040120706742676ddc2187170932bb344e901";

function setTrustedOracle(chain: Chain, senderAddress: string): Block {
  return chain.mineBlock([
    Tx.contractCall(dlcManagerContract, "set-trusted-oracle", [trustedOraclePubkey, types.bool(true)], senderAddress),
  ]);
}

function openLoan(chain: Chain, protocol_contract_user: Account, deployer: Account, callbackContract: string, loanParams: { vaultAmount: number, btcDeposit: number, liquidationRatio: number, liquidationFee: number } = { vaultAmount: 1000000, btcDeposit: 1, liquidationRatio: 14000, liquidationFee: 1000 }) {
  const block = chain.mineBlock([
    Tx.contractCall(callbackContract, "setup-loan", [types.uint(shiftPriceValue(loanParams.btcDeposit)), types.uint(loanParams.liquidationRatio), types.uint(loanParams.liquidationFee), types.uint(10)], protocol_contract_user.address)
  ]);

  block.receipts[0].result.expectOk().expectBool(true);

  const setupLoanPrintEvent = block.receipts[0].events[0];

  assertEquals(typeof setupLoanPrintEvent, 'object');
  assertEquals(setupLoanPrintEvent.type, 'contract_event');
  assertEquals(setupLoanPrintEvent.contract_event.topic, "print");
  assertStringIncludes(setupLoanPrintEvent.contract_event.value, 'loan-id: u1, status: "not-ready", uuid: none')

  const createDLCPrintEvent = block.receipts[0].events[1];

  assertEquals(typeof createDLCPrintEvent, 'object');
  assertEquals(createDLCPrintEvent.type, 'contract_event');
  assertEquals(createDLCPrintEvent.contract_event.topic, "print");
  let matchRegex =
    assertMatch(createDLCPrintEvent.contract_event.value, new RegExp(/^{callback-contract: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, creator: ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG, emergency-refund-time: u10, event-source: "dlclink:create-dlc:v0-1", nonce: u1, uuid: \(ok 0x[a-fA-F0-9]{64}\)\}$/))

  const loanBlock = chain.mineBlock([
    Tx.contractCall(callbackContract, "get-loan", [types.uint(1)], protocol_contract_user.address)
  ]);

  //The loan account in the sample protocl contact
  const loan: any = loanBlock.receipts[0].result.expectSome().expectTuple();

  assertEquals(loan.dlc_uuid, 'none');
  assertEquals(loan.status, '"not-ready"');
  assertEquals(loan['vault-collateral'], "u100000000");
  assertEquals(loan['vault-loan'], "u0");

  const block2 = chain.mineBlock([
    Tx.contractCall(dlcManagerContract, "post-create-dlc", [types.buff(UUID), types.uint(10), types.principal(callbackContract), types.principal(callbackContract), types.uint(1)], deployer.address)
  ]);

  block2.receipts[0].result.expectOk().expectBool(true);
  const createDLCInternalPrintEvent = block2.receipts[0].events[0];
  const callbackPrintEvent = block2.receipts[0].events[1];
  const mintEvent = block2.receipts[0].events[2];

  assertEquals(typeof createDLCInternalPrintEvent, 'object');
  assertEquals(createDLCInternalPrintEvent.type, 'contract_event');
  assertEquals(createDLCInternalPrintEvent.contract_event.topic, "print");
  assertStringIncludes(createDLCInternalPrintEvent.contract_event.value, 'creator: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, emergency-refund-time: u10, event-source: "dlclink:post-create-dlc:v0-1", uuid: 0x66616b6575756964')

  assertEquals(typeof callbackPrintEvent, 'object');
  assertEquals(callbackPrintEvent.type, 'contract_event');
  assertEquals(callbackPrintEvent.contract_event.topic, "print");
  assertStringIncludes(callbackPrintEvent.contract_event.value, 'loan-id: u1, status: "ready", uuid: (some 0x66616b6575756964)')

  assertEquals(typeof mintEvent, 'object');
  assertEquals(mintEvent.type, 'nft_mint_event');
  assertEquals(mintEvent.nft_mint_event.asset_identifier.split("::")[1], nftAssetContract);
  assertEquals(mintEvent.nft_mint_event.recipient.split(".")[1], dlcManagerContract);
}

Clarinet.test({
  name: "setup-loan on sample contract creates the loan, emits a dlclink event, and mints an nft",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('protocol_contract_deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    openLoan(chain, protocol_contract_user, deployer, contractPrincipal(protocol_contract_deployer, sampleProtocolContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "get-dlc", [types.buff(UUID)], deployer.address)
    ]);
    //The DLC is in the dlc-manager contract
    const dlc: any = block.receipts[0].result.expectSome().expectTuple();

    assertEquals(hex2ascii(dlc.uuid), "fakeuuid");
    assertEquals(dlc.creator, "STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1");

    let block2 = chain.mineBlock([
      Tx.contractCall(contractPrincipal(protocol_contract_deployer, sampleProtocolContract), "get-loan", [types.uint(1)], protocol_contract_user.address)
    ]);

    //The loan account in the sample protocl contact
    const loan: any = block2.receipts[0].result.expectSome().expectTuple();
    const dlcUuid = loan.dlc_uuid.expectSome();

    assertEquals(hex2ascii(dlcUuid), "fakeuuid");
    assertEquals(loan.status, '"ready"');
    assertEquals(loan['vault-collateral'], "u100000000");
    assertEquals(loan['vault-loan'], "u0");
  },
});

Clarinet.test({
  name: "get-loan-by-uuid works after creating the loan",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('protocol_contract_deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    openLoan(chain, protocol_contract_user, deployer, contractPrincipal(protocol_contract_deployer, sampleProtocolContract));

    let block = chain.mineBlock([
      Tx.contractCall(contractPrincipal(protocol_contract_deployer, sampleProtocolContract), "get-loan-by-uuid", [types.buff(UUID)], protocol_contract_user.address)
    ]);

    const account: any = block.receipts[0].result.expectOk();
    assertStringIncludes(account, 'dlc_uuid: (some 0x66616b6575756964), liquidation-fee: u1000, liquidation-ratio: u14000, owner: ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG, status: "ready", vault-collateral: u100000000, vault-loan: u0');
  },
});

// Clarinet.test({
//   name: "close-loan on sample protocol contract should close the loan, emit a dlclink event, and burn the nft",
//   async fn(chain: Chain, accounts: Map<string, Account>) {
//     const deployer = accounts.get('deployer')!;
//     const deployer_2 = accounts.get('deployer_2')!;

//     openLoan(chain, deployer, contractPrincipal(deployer_2, sampleProtocolContract));

//     let block = chain.mineBlock([
//       Tx.contractCall(contractPrincipal(deployer_2, sampleProtocolContract), "close-loan", [types.uint(1)], deployer_2.address)
//     ]);
//     assertStringIncludes(block.receipts[0].events[0].contract_event.value, 'status: "pre-repaid", uuid: 0x66616b6575756964');
//     assertStringIncludes(block.receipts[0].events[1].contract_event.value, 'callback-contract: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, caller: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, creator: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, event-source: "dlclink:close-dlc:v0-1", outcome: u0, uuid: 0x66616b6575756964')

//     const block2 = chain.mineBlock([
//       Tx.contractCall(dlcManagerContract, "post-close-dlc", [types.buff(UUID), types.principal(contractPrincipal(deployer_2, sampleProtocolContract))], deployer.address)
//     ]);

//     assertStringIncludes(block2.receipts[0].events[0].contract_event.value, 'closing-price: none, event-source: "dlclink:close-dlc-internal:v0", uuid: 0x66616b6575756964')
//     const burnEvent = block2.receipts[0].events[2];
//     assertEquals(typeof burnEvent, 'object');
//     assertEquals(burnEvent.type, 'nft_burn_event');
//     assertEquals(burnEvent.nft_burn_event.asset_identifier.split("::")[1], nftAssetContract);
//     assertEquals(burnEvent.nft_burn_event.sender.split(".")[1], dlcManagerContract);
//     assertEquals(hex2ascii(burnEvent.nft_burn_event.value), UUID);

//     let block3 = chain.mineBlock([
//       Tx.contractCall(contractPrincipal(deployer_2, sampleProtocolContract), "get-loan", [types.uint(1)], deployer.address)
//     ]);
//     //The loan account in the sample protocl contact
//     const loan: any = block3.receipts[0].result.expectSome().expectTuple();
//     const dlcUuid = loan.dlc_uuid.expectSome();

//     assertEquals(hex2ascii(dlcUuid), "fakeuuid");
//     assertEquals(loan.status, '"repaid"');
//     assertEquals(loan['closing-price'], "none");
//     assertEquals(loan['vault-collateral'], "u100000000");
//     assertEquals(loan['vault-loan'], "u1000000");
//   },
// });


// Clarinet.test({
//   name: "liquidate loan on sample contract should close the loan, emit a dlclink event, and burn the nft",
//   async fn(chain: Chain, accounts: Map<string, Account>) {
//     const deployer = accounts.get('deployer')!;
//     const deployer_2 = accounts.get('deployer_2')!;

//     openLoan(chain, deployer, contractPrincipal(deployer_2, sampleProtocolContract));
//     setTrustedOracle(chain, deployer.address);

//     let liquidateCall = chain.mineBlock([
//       Tx.contractCall(contractPrincipal(deployer_2, sampleProtocolContract), "liquidate-loan", [types.uint(1), types.uint(10000)], deployer_2.address),
//     ]);
//     assertStringIncludes(liquidateCall.receipts[0].events[0].contract_event.value, 'btc-price: u10000, status: "pre-liquidated", uuid: 0x66616b6575756964');
//     assertStringIncludes(liquidateCall.receipts[0].events[1].contract_event.value, 'caller: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, creator: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.sample-contract-loan-v0-1, event-source: "dlclink:close-dlc-liquidate:v0", uuid: 0x66616b6575756964');

//     let block = chain.mineBlock([
//       Tx.contractCall(dlcManagerContract, "close-dlc-liquidate-internal", [types.buff(UUID), packageCVForLiquidation.timestamp, packageCVForLiquidation.prices, signatureForLiquidation, types.principal(contractPrincipal(deployer_2, sampleProtocolContract))], deployer.address),
//       Tx.contractCall(dlcManagerContract, "get-dlc", [types.buff(UUID)], deployer.address)
//     ]);

//     block.receipts[0].result.expectOk().expectBool(true);
//     const printEvent2 = block.receipts[0].events[0];

//     assertEquals(typeof printEvent2, 'object');
//     assertEquals(printEvent2.type, 'contract_event');
//     assertEquals(printEvent2.contract_event.topic, "print");
//     assertStringIncludes(printEvent2.contract_event.value, 'actual-closing-time: u1647332, closing-price: u1358866993200, event-source: "dlclink:close-dlc-liquidate-internal:v0", payout-ratio: (ok u80949850), uuid: 0x66616b6575756964')

//     const burnEvent = block.receipts[0].events[2];

//     assertEquals(typeof burnEvent, 'object');
//     assertEquals(burnEvent.type, 'nft_burn_event');
//     assertEquals(burnEvent.nft_burn_event.asset_identifier.split("::")[1], nftAssetContract);
//     assertEquals(burnEvent.nft_burn_event.sender.split(".")[1], dlcManagerContract);

//     const dlc: any = block.receipts[1].result.expectSome().expectTuple();
//     assertEquals(dlc['closing-price'], "(some u1358866993200)")

//     let block2 = chain.mineBlock([
//       Tx.contractCall(contractPrincipal(deployer_2, sampleProtocolContract), "get-loan", [types.uint(1)], deployer.address)
//     ]);
//     //The loan account in the sample protocl contact
//     const loan: any = block2.receipts[0].result.expectSome().expectTuple();
//     const dlcUuid = loan.dlc_uuid.expectSome();

//     assertEquals(hex2ascii(dlcUuid), "fakeuuid");
//     assertEquals(loan.status, '"liquidated"');
//     assertEquals(loan['closing-price'], "(some u1358866993200)");
//   },
// });
