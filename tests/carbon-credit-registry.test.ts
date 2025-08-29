import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ValidatorInfo {
  active: boolean;
  addedAt: number;
}

interface Proposal {
  issuer: string;
  amount: number;
  metadata: string;
  hash: Buffer;
  approvals: string[];
  requiredApprovals: number;
  timestamp: number;
  status: string;
}

interface Credit {
  owner: string;
  amount: number;
  metadata: string;
  hash: Buffer;
  issuanceTimestamp: number;
  status: string;
}

interface ContractState {
  contractPaused: boolean;
  totalCredits: number;
  proposalCounter: number;
  admin: string;
  validators: Map<string, ValidatorInfo>;
  pendingProposals: Map<number, Proposal>;
  credits: Map<number, Credit>;
  creditOwnership: Map<string, number>;
}

// Mock contract implementation
class CarbonCreditRegistryMock {
  private state: ContractState = {
    contractPaused: false,
    totalCredits: 0,
    proposalCounter: 0,
    admin: "deployer",
    validators: new Map(),
    pendingProposals: new Map(),
    credits: new Map(),
    creditOwnership: new Map(),
  };

  private MAX_METADATA_LEN = 500;
  private MAX_APPROVALS = 10;
  private DEFAULT_REQUIRED_APPROVALS = 3;
  private ERR_UNAUTHORIZED = 100;
  private ERR_ALREADY_REGISTERED = 101;
  private ERR_INVALID_AMOUNT = 102;
  private ERR_INVALID_METADATA = 103;
  private ERR_INSUFFICIENT_APPROVALS = 104;
  private ERR_ALREADY_APPROVED = 105;
  private ERR_NOT_PENDING = 106;
  private ERR_CREDIT_NOT_FOUND = 107;
  private ERR_INVALID_STATUS = 108;
  private ERR_PAUSED = 109;
  private ERR_INVALID_HASH = 110;
  private ERR_MAX_APPROVALS_REACHED = 111;
  private ERR_INVALID_VALIDATOR = 112;

  private mockBlockHeight = 100;

  proposeCreditIssuance(caller: string, amount: number, metadata: string, hash: Buffer): ClarityResponse<number> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA };
    }
    if (hash.length !== 32 || hash.every(byte => byte === 0)) {
      return { ok: false, value: this.ERR_INVALID_HASH };
    }
    if (this.state.creditOwnership.has(hash.toString('hex'))) {
      return { ok: false, value: this.ERR_ALREADY_REGISTERED };
    }
    const proposalId = this.state.proposalCounter + 1;
    this.state.pendingProposals.set(proposalId, {
      issuer: caller,
      amount,
      metadata,
      hash,
      approvals: [],
      requiredApprovals: this.DEFAULT_REQUIRED_APPROVALS,
      timestamp: this.mockBlockHeight,
      status: "pending",
    });
    this.state.proposalCounter = proposalId;
    return { ok: true, value: proposalId };
  }

  approveProposal(caller: string, proposalId: number): ClarityResponse<boolean | number> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const proposal = this.state.pendingProposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_NOT_PENDING };
    }
    const validator = this.state.validators.get(caller);
    if (!validator || !validator.active) {
      return { ok: false, value: this.ERR_INVALID_VALIDATOR };
    }
    if (proposal.status !== "pending") {
      return { ok: false, value: this.ERR_NOT_PENDING };
    }
    if (proposal.approvals.includes(caller)) {
      return { ok: false, value: this.ERR_ALREADY_APPROVED };
    }
    if (proposal.approvals.length >= this.MAX_APPROVALS) {
      return { ok: false, value: this.ERR_MAX_APPROVALS_REACHED };
    }
    const newApprovals = [...proposal.approvals, caller];
    const updatedProposal = { ...proposal, approvals: newApprovals };
    this.state.pendingProposals.set(proposalId, updatedProposal);
    if (newApprovals.length >= proposal.requiredApprovals) {
      const creditId = this.state.totalCredits + 1;
      this.state.credits.set(creditId, {
        owner: proposal.issuer,
        amount: proposal.amount,
        metadata: proposal.metadata,
        hash: proposal.hash,
        issuanceTimestamp: this.mockBlockHeight,
        status: "active",
      });
      this.state.creditOwnership.set(proposal.hash.toString('hex'), creditId);
      this.state.pendingProposals.set(proposalId, { ...updatedProposal, status: "approved" });
      this.state.totalCredits = creditId;
      return { ok: true, value: creditId };
    }
    return { ok: true, value: true };
  }

  rejectProposal(caller: string, proposalId: number): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const proposal = this.state.pendingProposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_NOT_PENDING };
    }
    const validator = this.state.validators.get(caller);
    if (!validator || !validator.active) {
      return { ok: false, value: this.ERR_INVALID_VALIDATOR };
    }
    if (proposal.status !== "pending") {
      return { ok: false, value: this.ERR_NOT_PENDING };
    }
    this.state.pendingProposals.set(proposalId, { ...proposal, status: "rejected" });
    return { ok: true, value: true };
  }

  transferCredit(caller: string, creditId: number, newOwner: string): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const credit = this.state.credits.get(creditId);
    if (!credit) {
      return { ok: false, value: this.ERR_CREDIT_NOT_FOUND };
    }
    if (credit.owner !== caller) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (credit.status !== "active") {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    this.state.credits.set(creditId, { ...credit, owner: newOwner });
    return { ok: true, value: true };
  }

  retireCredit(caller: string, creditId: number): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const credit = this.state.credits.get(creditId);
    if (!credit) {
      return { ok: false, value: this.ERR_CREDIT_NOT_FOUND };
    }
    if (credit.owner !== caller) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (credit.status !== "active") {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    this.state.credits.set(creditId, { ...credit, status: "retired" });
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  addValidator(caller: string, validator: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (this.state.validators.has(validator)) {
      return { ok: false, value: this.ERR_ALREADY_REGISTERED };
    }
    this.state.validators.set(validator, { active: true, addedAt: this.mockBlockHeight });
    return { ok: true, value: true };
  }

  removeValidator(caller: string, validator: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (!this.state.validators.has(validator)) {
      return { ok: false, value: this.ERR_INVALID_VALIDATOR };
    }
    this.state.validators.set(validator, { active: false, addedAt: this.state.validators.get(validator)!.addedAt });
    return { ok: true, value: true };
  }

  getCreditDetails(creditId: number): ClarityResponse<Credit | null> {
    return { ok: true, value: this.state.credits.get(creditId) ?? null };
  }

  getProposalDetails(proposalId: number): ClarityResponse<Proposal | null> {
    return { ok: true, value: this.state.pendingProposals.get(proposalId) ?? null };
  }

  getCreditByHash(hash: Buffer): ClarityResponse<Credit | null> {
    const creditId = this.state.creditOwnership.get(hash.toString('hex'));
    return { ok: true, value: creditId ? this.state.credits.get(creditId) ?? null : null };
  }

  isValidator(validator: string): ClarityResponse<boolean> {
    const validatorInfo = this.state.validators.get(validator);
    return { ok: true, value: validatorInfo ? validatorInfo.active : false };
  }

  getTotalCredits(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalCredits };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  issuer: "wallet_1",
  validator1: "wallet_2",
  validator2: "wallet_3",
  validator3: "wallet_4",
  user: "wallet_5",
};

describe("CarbonCreditRegistry Contract", () => {
  let contract: CarbonCreditRegistryMock;

  beforeEach(() => {
    contract = new CarbonCreditRegistryMock();
    vi.resetAllMocks();
  });

  it("should initialize with correct state", () => {
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.deployer });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
    expect(contract.getTotalCredits()).toEqual({ ok: true, value: 0 });
  });

  it("should allow issuer to propose credit issuance", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    const proposeResult = contract.proposeCreditIssuance(
      accounts.issuer,
      1000,
      "Carbon offset from Project XYZ",
      hash
    );
    expect(proposeResult).toEqual({ ok: true, value: 1 });

    const proposal = contract.getProposalDetails(1);
    expect(proposal).toEqual({
      ok: true,
      value: expect.objectContaining({
        issuer: accounts.issuer,
        amount: 1000,
        metadata: "Carbon offset from Project XYZ",
        hash,
        status: "pending",
        requiredApprovals: 3,
        approvals: [],
      }),
    });
  });

  it("should prevent invalid credit issuance proposals", () => {
    const validHash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    const invalidHash = Buffer.alloc(32, 0);

    expect(contract.proposeCreditIssuance(accounts.issuer, 0, "Invalid amount", validHash)).toEqual({
      ok: false,
      value: 102,
    });

    expect(contract.proposeCreditIssuance(accounts.issuer, 1000, "a".repeat(501), validHash)).toEqual({
      ok: false,
      value: 103,
    });

    expect(contract.proposeCreditIssuance(accounts.issuer, 1000, "Valid", invalidHash)).toEqual({
      ok: false,
      value: 110,
    });
  });

  it("should allow validators to approve proposals and issue credits", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    contract.addValidator(accounts.deployer, accounts.validator1);
    contract.addValidator(accounts.deployer, accounts.validator2);
    contract.addValidator(accounts.deployer, accounts.validator3);

    contract.proposeCreditIssuance(accounts.issuer, 1000, "Carbon offset from Project XYZ", hash);

    contract.approveProposal(accounts.validator1, 1);
    contract.approveProposal(accounts.validator2, 1);
    const issueResult = contract.approveProposal(accounts.validator3, 1);

    expect(issueResult).toEqual({ ok: true, value: 1 });

    const credit = contract.getCreditDetails(1);
    expect(credit).toEqual({
      ok: true,
      value: expect.objectContaining({
        owner: accounts.issuer,
        amount: 1000,
        metadata: "Carbon offset from Project XYZ",
        hash,
        status: "active",
      }),
    });

    expect(contract.getCreditByHash(hash)).toEqual(credit);
    expect(contract.getTotalCredits()).toEqual({ ok: true, value: 1 });
  });

  it("should prevent unauthorized or invalid approvals", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    contract.addValidator(accounts.deployer, accounts.validator1);
    contract.proposeCreditIssuance(accounts.issuer, 1000, "Carbon offset from Project XYZ", hash);

    expect(contract.approveProposal(accounts.user, 1)).toEqual({ ok: false, value: 112 });
    expect(contract.approveProposal(accounts.validator1, 2)).toEqual({ ok: false, value: 106 });
    contract.approveProposal(accounts.validator1, 1);
    expect(contract.approveProposal(accounts.validator1, 1)).toEqual({ ok: false, value: 105 });
  });

  it("should allow validators to reject proposals", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    contract.addValidator(accounts.deployer, accounts.validator1);
    contract.proposeCreditIssuance(accounts.issuer, 1000, "Carbon offset from Project XYZ", hash);

    const rejectResult = contract.rejectProposal(accounts.validator1, 1);
    expect(rejectResult).toEqual({ ok: true, value: true });

    const proposal = contract.getProposalDetails(1);
    expect(proposal).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "rejected" }),
    });
  });

  it("should allow credit transfers", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    contract.addValidator(accounts.deployer, accounts.validator1);
    contract.addValidator(accounts.deployer, accounts.validator2);
    contract.addValidator(accounts.deployer, accounts.validator3);
    contract.proposeCreditIssuance(accounts.issuer, 1000, "Carbon offset from Project XYZ", hash);
    contract.approveProposal(accounts.validator1, 1);
    contract.approveProposal(accounts.validator2, 1);
    contract.approveProposal(accounts.validator3, 1);

    const transferResult = contract.transferCredit(accounts.issuer, 1, accounts.user);
    expect(transferResult).toEqual({ ok: true, value: true });

    const credit = contract.getCreditDetails(1);
    expect(credit).toEqual({
      ok: true,
      value: expect.objectContaining({ owner: accounts.user }),
    });
  });

  it("should allow credit retirement", () => {
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");
    contract.addValidator(accounts.deployer, accounts.validator1);
    contract.addValidator(accounts.deployer, accounts.validator2);
    contract.addValidator(accounts.deployer, accounts.validator3);
    contract.proposeCreditIssuance(accounts.issuer, 1000, "Carbon offset from Project XYZ", hash);
    contract.approveProposal(accounts.validator1, 1);
    contract.approveProposal(accounts.validator2, 1);
    contract.approveProposal(accounts.validator3, 1);

    const retireResult = contract.retireCredit(accounts.issuer, 1);
    expect(retireResult).toEqual({ ok: true, value: true });

    const credit = contract.getCreditDetails(1);
    expect(credit).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "retired" }),
    });
  });

  it("should handle admin functions correctly", () => {
    expect(contract.setAdmin(accounts.deployer, accounts.user)).toEqual({ ok: true, value: true });
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.user });

    expect(contract.pauseContract(accounts.user)).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });

    expect(contract.unpauseContract(accounts.user)).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it("should manage validators correctly", () => {
    expect(contract.addValidator(accounts.deployer, accounts.validator1)).toEqual({ ok: true, value: true });
    expect(contract.isValidator(accounts.validator1)).toEqual({ ok: true, value: true });

    expect(contract.removeValidator(accounts.deployer, accounts.validator1)).toEqual({ ok: true, value: true });
    expect(contract.isValidator(accounts.validator1)).toEqual({ ok: true, value: false });
  });

  it("should prevent operations when paused", () => {
    contract.pauseContract(accounts.deployer);
    const hash = Buffer.from("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "hex");

    expect(contract.proposeCreditIssuance(accounts.issuer, 1000, "Test", hash)).toEqual({
      ok: false,
      value: 109,
    });
    expect(contract.approveProposal(accounts.validator1, 1)).toEqual({ ok: false, value: 109 });
    expect(contract.transferCredit(accounts.issuer, 1, accounts.user)).toEqual({ ok: false, value: 109 });
    expect(contract.retireCredit(accounts.issuer, 1)).toEqual({ ok: false, value: 109 });
  });
});