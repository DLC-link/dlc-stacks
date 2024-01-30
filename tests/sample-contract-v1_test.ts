// deno-lint-ignore-file require-await no-explicit-any prefer-const
import {
  Clarinet,
  Tx,
  Chain,
  Account,
  types,
  assertEquals,
  pricePackageToCV,
  assertStringIncludes,
  assertMatch,
  hex2ascii,
  shiftPriceValue,
  PricePackage,
  Block,
  customShiftValue,
  //@ts-ignore-next-line
} from './deps.ts';

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

const BTChex = 'BTC';
// const UUID = UUID;
const nftAssetContract = 'open-dlc';
const dlcManagerContract = 'dlc-manager-v1-1';
const sampleProtocolContract = 'sample-contract-loan-v1-1';
const stableCoinContract = 'dlc-stablecoin-v1-1';
const stableCoinDecimals = 6;
const mockFundingTxId = 'F4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';

const contractPrincipal = (deployer: Account, contract: string) => `${deployer.address}.${contract}`;

function openLoan(
  chain: Chain,
  protocol_contract_user: Account,
  protocol_contract_deployer: Account,
  deployer: Account,
  callbackContract: string,
  loanParams: {
    vaultAmount: number;
    btcDeposit: number;
  } = {
    vaultAmount: 1000000,
    btcDeposit: 1,
  }
) {
  chain.mineBlock([
    Tx.contractCall(
      dlcManagerContract,
      'register-contract',
      [types.principal(contractPrincipal(protocol_contract_deployer, sampleProtocolContract))],
      deployer.address
    ),
  ]);

  const block = chain.mineBlock([
    Tx.contractCall(
      callbackContract,
      'setup-loan',
      [types.uint(shiftPriceValue(loanParams.btcDeposit))],
      protocol_contract_user.address
    ),
  ]);

  block.receipts[0].result.expectOk();

  const createDLCPrintEvent = block.receipts[0].events.find((event: any) => {
    return event.contract_event && event.contract_event.contract_identifier.includes('dlc-manager-v1-1');
  });

  assertEquals(typeof createDLCPrintEvent, 'object');
  assertEquals(createDLCPrintEvent.type, 'contract_event');
  assertEquals(createDLCPrintEvent.contract_event.topic, 'print');

  const mintEvent = block.receipts[0].events.find((event: any) => {
    return event.nft_mint_event && event.nft_mint_event.asset_identifier.includes('open-dlc');
  });

  assertEquals(typeof mintEvent, 'object');
  assertEquals(mintEvent.type, 'nft_mint_event');
  assertEquals(mintEvent.nft_mint_event.asset_identifier.split('::')[1], nftAssetContract);
  assertEquals(mintEvent.nft_mint_event.recipient.split('.')[1], dlcManagerContract);

  const loanBlock = chain.mineBlock([
    Tx.contractCall(callbackContract, 'get-loan', [types.uint(1)], protocol_contract_user.address),
  ]);

  //The loan account in the sample protocl contact
  const loan: any = loanBlock.receipts[0].result.expectSome().expectTuple();

  assertMatch(loan.dlc_uuid, new RegExp(/^0x[a-fA-F0-9]{64}$/));
  assertEquals(loan.status, '"ready"');
  assertEquals(loan['vault-collateral'], 'u100000000');
  assertEquals(loan['vault-loan'], 'u0');

  return loan.dlc_uuid;
}

Clarinet.test({
  name: 'setup-loan on sample contract creates the loan, emits a dlclink event, and mints an nft',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    const UUID = openLoan(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      deployer,
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract)
    );

    let block = chain.mineBlock([Tx.contractCall(dlcManagerContract, 'get-dlc', [UUID], deployer.address)]);

    const dlc: any = block.receipts[0].result.expectSome().expectTuple();

    assertEquals(dlc.uuid, UUID);
    assertEquals(dlc.creator, protocol_contract_user.address);

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan',
        [types.uint(1)],
        protocol_contract_user.address
      ),
    ]);

    //The loan account in the sample protocl contact
    const loan: any = block2.receipts[0].result.expectSome().expectTuple();
    const dlcUuid = loan.dlc_uuid;

    assertEquals(dlcUuid, UUID);
    assertEquals(loan.status, '"ready"');
    assertEquals(loan['vault-collateral'], 'u100000000');
    assertEquals(loan['vault-loan'], 'u0');
  },
});

Clarinet.test({
  name: 'get-loan-by-uuid works after creating the loan',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    const UUID = openLoan(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      deployer,
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract)
    );

    let block = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan-by-uuid',
        [UUID],
        protocol_contract_user.address
      ),
    ]);

    const account: any = block.receipts[0].result.expectOk();
    assertStringIncludes(
      account,
      `closing-tx-id: none, dlc_uuid: ${UUID}, funding-tx-id: none, liquidation-fee: u1000, liquidation-ratio: u14000, owner: ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG, status: "ready", vault-collateral: u100000000, vault-loan: u0`
    );
  },
});

Clarinet.test({
  name: 'close-loan on sample protocol contract should close the loan, emit a dlclink event, and burn the nft',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    const UUID = openLoan(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      deployer,
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract)
    );

    let block = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'close-loan',
        [types.uint(1)],
        protocol_contract_user.address
      ),
    ]);

    assertStringIncludes(
      block.receipts[0].events[0].contract_event.value,
      `{creator: ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG, event-source: "dlclink:close-dlc:v1", outcome: u0, uuid: ${UUID}}`
    );

    const burnEvent = block.receipts[0].events[1];
    assertEquals(typeof burnEvent, 'object');
    assertEquals(burnEvent.type, 'nft_burn_event');
    assertEquals(burnEvent.nft_burn_event.asset_identifier.split('::')[1], nftAssetContract);
    assertEquals(burnEvent.nft_burn_event.sender.split('.')[1], dlcManagerContract);
    assertEquals(burnEvent.nft_burn_event.value, UUID);

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan',
        [types.uint(1)],
        deployer.address
      ),
    ]);
    //The loan account in the sample protocl contact
    const loan: any = block2.receipts[0].result.expectSome().expectTuple();
    const dlcUuid = loan.dlc_uuid;

    assertEquals(dlcUuid, UUID);
    assertEquals(loan.status, '"pre-repaid"');
    assertEquals(loan['vault-collateral'], 'u100000000');
    assertEquals(loan['vault-loan'], 'u0');
  },
});

Clarinet.test({
  name: 'cannot borrow on unfunded vault',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;

    const UUID = openLoan(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      deployer,
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract)
    );

    let block = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'borrow',
        [types.uint(1), types.uint(100000000)],
        protocol_contract_user.address
      ),
    ]);

    block.receipts[0].result.expectErr().expectUint(1009);
  },
});

function setupAndBorrow(
  chain: Chain,
  protocol_contract_user: Account,
  protocol_contract_deployer: Account,
  protocol_wallet: Account,
  deployer: Account,
  borrowAmount: number
) {
  let mintStablecoinToProtocolContract = chain.mineBlock([
    Tx.contractCall(
      contractPrincipal(deployer, stableCoinContract),
      'mint',
      [
        types.uint(1000000000000),
        types.principal(contractPrincipal(protocol_contract_deployer, sampleProtocolContract)),
      ],
      deployer.address
    ),
  ]);

  const UUID = openLoan(
    chain,
    protocol_contract_user,
    protocol_contract_deployer,
    deployer,
    contractPrincipal(protocol_contract_deployer, sampleProtocolContract)
  );

  let ssf = chain.mineBlock([
    Tx.contractCall(
      dlcManagerContract,
      'set-status-funded',
      [
        UUID,
        types.ascii(mockFundingTxId),
        types.principal(contractPrincipal(protocol_contract_deployer, sampleProtocolContract)),
      ],
      protocol_wallet.address
    ),
  ]);

  ssf.receipts[0].result.expectOk().expectBool(true);

  let block = chain.mineBlock([
    Tx.contractCall(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'borrow',
      [types.uint(1), types.uint(borrowAmount)],
      protocol_contract_user.address
    ),
  ]);

  block.receipts[0].result.expectOk().expectBool(true);
  return UUID;
}

Clarinet.test({
  name: 'borrow increases the loan amount',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = 100000000; // $100

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan',
        [types.uint(1)],
        deployer.address
      ),
    ]);
    //The loan account in the sample protocl contact
    const loan: any = block2.receipts[0].result.expectSome().expectTuple();
    const dlcUuid = loan.dlc_uuid;

    assertEquals(dlcUuid, UUID);
    assertEquals(loan.status, '"funded"');
    assertEquals(loan['vault-collateral'], 'u100000000');
    assertEquals(loan['vault-loan'], `u${borrowAmount}`);
  },
});

Clarinet.test({
  name: 'cannot close loan if not repaid',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = 100000000; // $100

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    let block = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'close-loan',
        [types.uint(1)],
        protocol_contract_user.address
      ),
    ]);

    block.receipts[0].result.expectErr().expectUint(1013);
  },
});

Clarinet.test({
  name: 'repay decreases the loan amount',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = 100000000; // $100
    const repayAmount = 50000000; // $50

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    let block = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan',
        [types.uint(1)],
        deployer.address
      ),
    ]);
    //The loan account in the sample protocl contact
    const loan: any = block.receipts[0].result.expectSome().expectTuple();
    const dlcUuid = loan.dlc_uuid;

    assertEquals(dlcUuid, UUID);
    assertEquals(loan['vault-loan'], `u${borrowAmount}`);

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'repay',
        [types.uint(1), types.uint(repayAmount)],
        protocol_contract_user.address
      ),
    ]);

    block2.receipts[0].result.expectOk().expectBool(true);

    let block3 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'get-loan',
        [types.uint(1)],
        deployer.address
      ),
    ]);

    //The loan account in the sample protocl contact
    const loan2: any = block3.receipts[0].result.expectSome().expectTuple();
    assertEquals(loan2['vault-loan'], `u${borrowAmount - repayAmount}`);
  },
});

Clarinet.test({
  name: 'cannot repay more than borrowed amount',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = 100000000; // $100
    const repayAmount = 500000000; // $500

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'repay',
        [types.uint(1), types.uint(repayAmount)],
        protocol_contract_user.address
      ),
    ]);

    block2.receipts[0].result.expectErr().expectUint(1012);
  },
});

Clarinet.test({
  name: 'check-liquidation works as expected',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = customShiftValue(10000, stableCoinDecimals); // $10,000

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    const btcPrice = shiftPriceValue(30000); // $30,000
    let cl = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'check-liquidation',
      [types.uint(1), types.uint(btcPrice)],
      deployer.address
    );
    cl.result.expectOk().expectBool(false);

    const btcPrice2 = shiftPriceValue(15000); // $15,000
    let cl2 = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'check-liquidation',
      [types.uint(1), types.uint(btcPrice2)],
      deployer.address
    );
    cl2.result.expectOk().expectBool(false);

    // We expect liquidation at $14,000 for a loan of $10,000, with a 140% collateralization ratio
    const btcPrice3 = shiftPriceValue(14000); // $14,000
    let cl3 = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'check-liquidation',
      [types.uint(1), types.uint(btcPrice3)],
      deployer.address
    );
    cl3.result.expectOk().expectBool(true);
  },
});

Clarinet.test({
  name: 'get-payout-ratio works as expected',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const borrowAmount = customShiftValue(10000, stableCoinDecimals); // $10,000

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    let btcPrice = shiftPriceValue(30000); // $30,000
    let cl = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'get-payout-ratio',
      [types.uint(1), types.uint(btcPrice)],
      deployer.address
    );
    cl.result.expectOk().expectUint(0);

    btcPrice = shiftPriceValue(15000); // $15,000
    cl = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'get-payout-ratio',
      [types.uint(1), types.uint(btcPrice)],
      deployer.address
    );
    cl.result.expectOk().expectUint(0);

    // We expect liquidation at $14,000 for a loan of $10,000, with a 140% collateralization ratio
    btcPrice = shiftPriceValue(14000); // $14,000
    cl = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'get-payout-ratio',
      [types.uint(1), types.uint(btcPrice)],
      deployer.address
    );
    cl.result.expectOk().expectUint(7857);

    btcPrice = shiftPriceValue(10000); // $10,000
    cl = chain.callReadOnlyFn(
      contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
      'get-payout-ratio',
      [types.uint(1), types.uint(btcPrice)],
      deployer.address
    );

    // We expect that the payout ratio is capped at 100%
    cl.result.expectOk().expectUint(10000);
  },
});

Clarinet.test({
  name: 'attempt-liquidate fails if the loan is not underwater',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const liquidator_user = accounts.get('wallet_3')!;
    const borrowAmount = customShiftValue(10000, stableCoinDecimals); // $10,000

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    const btcPrice = shiftPriceValue(30000); // $30,000

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'attempt-liquidate',
        [types.uint(btcPrice), UUID],
        liquidator_user.address
      ),
    ]);

    block2.receipts[0].result.expectErr().expectUint(1007);
  },
});

Clarinet.test({
  name: 'attempt-liquidate should call the dlc-manager contract to close the dlc',
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const protocol_contract_deployer = accounts.get('deployer')!;
    const protocol_contract_user = accounts.get('protocol_contract_user')!;
    const protocol_wallet = accounts.get('protocol_wallet')!;
    const liquidator_user = accounts.get('wallet_3')!;
    const borrowAmount = customShiftValue(10000, stableCoinDecimals); // $10,000

    const UUID = setupAndBorrow(
      chain,
      protocol_contract_user,
      protocol_contract_deployer,
      protocol_wallet,
      deployer,
      borrowAmount
    );

    const btcPrice = shiftPriceValue(14000);

    let block2 = chain.mineBlock([
      Tx.contractCall(
        contractPrincipal(protocol_contract_deployer, sampleProtocolContract),
        'attempt-liquidate',
        [types.uint(btcPrice), UUID],
        liquidator_user.address
      ),
    ]);

    block2.receipts[0].result.expectOk().expectBool(true);

    const closeEvent = block2.receipts[0].events.find((event) =>
      event?.contract_event.value.includes('dlclink:close-dlc:v1')
    );

    assertStringIncludes(closeEvent?.contract_event.value, 'dlclink:close-dlc:v1');

    const nftBurnEvent = block2.receipts[0].events.find(
      (event) =>
        event?.nft_burn_event?.asset_identifier ==
        'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.dlc-manager-v1-1::open-dlc'
    );
    assertEquals(
      nftBurnEvent?.nft_burn_event.asset_identifier,
      'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.dlc-manager-v1-1::open-dlc'
    );
  },
});
