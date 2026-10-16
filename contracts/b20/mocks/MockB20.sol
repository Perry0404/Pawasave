// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * Local test doubles for the Base precompiles, modelling only the semantics PawaSave's B20 modules
 * rely on (base/base-std IB20, IB20Asset, IPolicyRegistry). The real precompiles are exercised by the
 * Base Sepolia run of scripts/b20-demo.ts.
 */
contract MockPolicyRegistry {
    uint64 public nextId = 1;
    mapping(uint64 => address) public policyAdmin;
    mapping(uint64 => mapping(address => bool)) public member;

    event PolicyCreated(uint64 indexed policyId, address indexed creator, uint8 policyType);

    function createPolicyWithAccounts(address admin, uint8 /* ALLOWLIST = 1 */, address[] calldata accounts)
        external
        returns (uint64 id)
    {
        id = nextId++;
        policyAdmin[id] = admin;
        for (uint256 i = 0; i < accounts.length; i++) member[id][accounts[i]] = true;
        emit PolicyCreated(id, msg.sender, 1);
    }

    function updateAllowlist(uint64 policyId, bool allowed, address[] calldata accounts) external {
        require(msg.sender == policyAdmin[policyId], "Unauthorized");
        for (uint256 i = 0; i < accounts.length; i++) member[policyId][accounts[i]] = allowed;
    }

    /// Policy 0 is the built-in always-allow, which is also what an unset token policy slot reads as.
    function isAuthorized(uint64 policyId, address account) external view returns (bool) {
        return policyId == 0 || member[policyId][account];
    }
}

contract MockB20Asset is ERC20Permit, AccessControl {
    bytes32 public constant MINT_ROLE = keccak256("MINT_ROLE");
    bytes32 public constant BURN_ROLE = keccak256("BURN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant TRANSFER_SENDER_POLICY = keccak256("TRANSFER_SENDER_POLICY");
    bytes32 public constant TRANSFER_RECEIVER_POLICY = keccak256("TRANSFER_RECEIVER_POLICY");
    bytes32 public constant TRANSFER_EXECUTOR_POLICY = keccak256("TRANSFER_EXECUTOR_POLICY");
    bytes32 public constant MINT_RECEIVER_POLICY = keccak256("MINT_RECEIVER_POLICY");

    MockPolicyRegistry public immutable registry;
    mapping(bytes32 => uint64) public policyId;
    uint256 public multiplier = 1e18;

    event Memo(address indexed caller, bytes32 indexed memo);

    constructor(string memory name_, string memory symbol_, address admin, MockPolicyRegistry registry_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function updatePolicy(bytes32 scope, uint64 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policyId[scope] = id;
    }

    function updateMultiplier(uint256 m) external onlyRole(OPERATOR_ROLE) {
        require(m > 0, "InvalidMultiplier");
        multiplier = m;
    }

    function _authorized(bytes32 scope, address account) internal view returns (bool) {
        return registry.isAuthorized(policyId[scope], account);
    }

    function _checkTransfer(address from, address to) internal view {
        require(_authorized(TRANSFER_EXECUTOR_POLICY, msg.sender), "PolicyForbids: executor");
        require(_authorized(TRANSFER_SENDER_POLICY, from), "PolicyForbids: sender");
        require(_authorized(TRANSFER_RECEIVER_POLICY, to), "PolicyForbids: receiver");
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _checkTransfer(msg.sender, to);
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _checkTransfer(from, to);
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function transferWithMemo(address to, uint256 amount, bytes32 memo) external returns (bool) {
        transfer(to, amount);
        emit Memo(msg.sender, memo);
        return true;
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) external returns (bool) {
        transferFrom(from, to, amount);
        emit Memo(msg.sender, memo);
        return true;
    }

    function mintWithMemo(address to, uint256 amount, bytes32 memo) external onlyRole(MINT_ROLE) {
        require(_authorized(MINT_RECEIVER_POLICY, to), "PolicyForbids: mint receiver");
        _mint(to, amount);
        emit Memo(msg.sender, memo);
    }

    function burnWithMemo(uint256 amount, bytes32 memo) external onlyRole(BURN_ROLE) {
        _burn(msg.sender, amount);
        emit Memo(msg.sender, memo);
    }
}
