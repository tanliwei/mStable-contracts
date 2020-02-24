pragma solidity ^0.5.16;

import { ERC20Detailed } from "openzeppelin-solidity/contracts/token/ERC20/ERC20Detailed.sol";
import { ERC20Burnable } from "openzeppelin-solidity/contracts/token/ERC20/ERC20Burnable.sol";

/**
 * @title MassetToken
 * @dev Basic Token functionality for Masset
 */
contract MassetToken is ERC20Burnable, ERC20Detailed {

    /** @dev constructor - create a burnable, mintable ERC20 token */
    constructor (
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    )
        ERC20Detailed(
            _name,
            _symbol,
            _decimals
        )
        public
    { }
}