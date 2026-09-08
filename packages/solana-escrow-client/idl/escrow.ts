/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/escrow.json`.
 */
export type Escrow = {
  "address": "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
  "metadata": {
    "name": "escrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "initializeCase",
      "docs": [
        "Claimant opens a case and deposits the disputed amount (lamports)",
        "into the case PDA. `adjudicator` is the authority allowed to call",
        "`settle` for this case."
      ],
      "discriminator": [
        9,
        26,
        237,
        193,
        224,
        164,
        59,
        208
      ],
      "accounts": [
        {
          "name": "claimant",
          "writable": true,
          "signer": true
        },
        {
          "name": "case",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "caseId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "caseId",
          "type": "string"
        },
        {
          "name": "respondent",
          "type": "pubkey"
        },
        {
          "name": "adjudicator",
          "type": "pubkey"
        },
        {
          "name": "amountLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "raiseDispute",
      "docs": [
        "Either party marks the case disputed — purely informational status",
        "for this reference implementation (no auto-release timeout logic",
        "yet); the real gate on fund movement is `settle`."
      ],
      "discriminator": [
        41,
        243,
        1,
        51,
        150,
        95,
        246,
        73
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "case",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "case.case_id",
                "account": "case"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "settle",
      "docs": [
        "Settles the case per an adjudication outcome, in basis points",
        "(0-10000, matching Anchor's claimant_share_bps/respondent_share_bps",
        "— see docs/decision-schema.md). Only the designated `adjudicator`",
        "authority may call this. Closes the case account, returning rent",
        "to the claimant."
      ],
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
      ],
      "accounts": [
        {
          "name": "adjudicator",
          "signer": true
        },
        {
          "name": "case",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "case.case_id",
                "account": "case"
              }
            ]
          }
        },
        {
          "name": "claimant",
          "writable": true
        },
        {
          "name": "respondent",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "claimantShareBps",
          "type": "u16"
        },
        {
          "name": "respondentShareBps",
          "type": "u16"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "case",
      "discriminator": [
        24,
        222,
        147,
        26,
        60,
        162,
        154,
        176
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "caseIdTooLong",
      "msg": "case_id exceeds max length"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "notActive",
      "msg": "case is not active"
    },
    {
      "code": 6003,
      "name": "alreadySettled",
      "msg": "case already settled"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "signer is not authorized for this action"
    },
    {
      "code": 6005,
      "name": "invalidShares",
      "msg": "claimant_share_bps + respondent_share_bps must equal 10000"
    },
    {
      "code": 6006,
      "name": "partyMismatch",
      "msg": "claimant/respondent accounts do not match the case"
    }
  ],
  "types": [
    {
      "name": "case",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "caseId",
            "type": "string"
          },
          {
            "name": "claimant",
            "type": "pubkey"
          },
          {
            "name": "respondent",
            "type": "pubkey"
          },
          {
            "name": "adjudicator",
            "type": "pubkey"
          },
          {
            "name": "amountLamports",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "caseStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "caseStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "disputed"
          },
          {
            "name": "settled"
          }
        ]
      }
    }
  ]
};
