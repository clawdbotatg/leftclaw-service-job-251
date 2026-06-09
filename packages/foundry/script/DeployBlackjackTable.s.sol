// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DeployHelpers.s.sol";
import "../contracts/BlackjackTable.sol";

/**
 * @notice Deploy script for BlackjackTable (CLAWD Blackjack — Neon Tokyo).
 * @dev Inherits ScaffoldETHDeploy and uses the ScaffoldEthDeployerRunner modifier so the
 *      deployer account is set up and contract addresses/ABIs are exported to the frontend.
 *
 * Example:
 *   yarn deploy --file DeployBlackjackTable.s.sol            # local anvil chain
 *   yarn deploy --file DeployBlackjackTable.s.sol --network base
 */
contract DeployBlackjackTable is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        address clawdToken = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
        address cvToken = address(0); // placeholder — owner will set via setCVToken()
        address clientWallet = 0xFE968dE21eb0E77d5877477C31a04A3075c0086E;

        BlackjackTable blackjack = new BlackjackTable(clawdToken, cvToken);

        // Transfer ownership to client (Ownable2Step: client must call acceptOwnership()).
        blackjack.transferOwnership(clientWallet);
    }
}
