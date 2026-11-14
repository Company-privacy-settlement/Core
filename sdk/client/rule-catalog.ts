import type { RuleCatalog } from "./rules.js";
/** Source-checked candidates, not professional approval. All calculations require an explicit mode. */
export const RULE_CATALOG:RuleCatalog = {
  "format": "core-rule-catalog-v1",
  "version": "2026.11.14.1",
  "engineVersion": "core-rules-v1",
  "sourceCheckedAt": "2026-11-14",
  "rules": [
    {
      "id": "us-fica-2025-v1",
      "kind": "us_fica",
      "jurisdictions": [
        "US-FEDERAL"
      ],
      "relationships": [
        "employee"
      ],
      "effectiveFrom": "2025-01-01",
      "effectiveThrough": "2025-12-31",
      "parameters": {
        "socialSecurityBaseMinor": "17610000",
        "socialSecurityBps": 620,
        "medicareBps": 145,
        "additionalMedicareBps": 90,
        "additionalMedicareThresholdMinor": "20000000"
      },
      "sources": [
        {
          "id": "irs-p15-2025",
          "title": "IRS Publication 15 (2025)",
          "url": "https://www.irs.gov/pub/irs-prior/p15--2025.pdf",
          "locator": "Section 10 and nonemployee compensation reporting",
          "checkedAt": "2026-11-14",
          "documentSha256": "168837bd5f666d8c0a7cd59a1309512c0429974b5b7b982ae781a3b9f925b7a0"
        }
      ],
      "limitations": [
        "Federal covered-wage components only; federal income withholding, FUTA and state/local obligations are not calculated.",
        "Only standard covered wages and one reviewed employer/YTD tax-year basis are supported; exemptions, tips, acquisitions, corrections and special worker classes require separate review."
      ]
    },
    {
      "id": "us-nec-2025-v1",
      "kind": "us_nec",
      "jurisdictions": [
        "US-FEDERAL"
      ],
      "relationships": [
        "contractor",
        "business"
      ],
      "effectiveFrom": "2025-01-01",
      "effectiveThrough": "2025-12-31",
      "parameters": {
        "reportingThresholdMinor": "60000"
      },
      "sources": [
        {
          "id": "irs-p15-2025",
          "title": "IRS Publication 15 (2025)",
          "url": "https://www.irs.gov/pub/irs-prior/p15--2025.pdf",
          "locator": "Section 10 and nonemployee compensation reporting",
          "checkedAt": "2026-11-14",
          "documentSha256": "168837bd5f666d8c0a7cd59a1309512c0429974b5b7b982ae781a3b9f925b7a0"
        }
      ],
      "limitations": [
        "Reporting trigger preparation only; no income/self-employment/backup withholding tax calculation or filing.",
        "Only reviewed reportable direct nonemployee-service payments to a US noncorporate payee; foreign payees, corporate exceptions, legal fees, platforms and payment cards require separate rules."
      ]
    },
    {
      "id": "us-fica-2026-v1",
      "kind": "us_fica",
      "jurisdictions": [
        "US-FEDERAL"
      ],
      "relationships": [
        "employee"
      ],
      "effectiveFrom": "2026-01-01",
      "effectiveThrough": "2026-12-31",
      "parameters": {
        "socialSecurityBaseMinor": "18450000",
        "socialSecurityBps": 620,
        "medicareBps": 145,
        "additionalMedicareBps": 90,
        "additionalMedicareThresholdMinor": "20000000"
      },
      "sources": [
        {
          "id": "irs-p15-2026",
          "title": "IRS Publication 15 (2026)",
          "url": "https://www.irs.gov/pub/irs-pdf/p15.pdf",
          "locator": "Sections 1 and 10; information-reporting threshold changes",
          "checkedAt": "2026-11-14",
          "documentSha256": "b46c3622439d8521e3a0faca4cd5b5ece3451b526f65f06a5e38d5c9f804c88b"
        }
      ],
      "limitations": [
        "Federal covered-wage components only; federal income withholding, FUTA and state/local obligations are not calculated.",
        "Only standard covered wages and one reviewed employer/YTD tax-year basis are supported; exemptions, tips, acquisitions, corrections and special worker classes require separate review."
      ]
    },
    {
      "id": "us-nec-2026-v1",
      "kind": "us_nec",
      "jurisdictions": [
        "US-FEDERAL"
      ],
      "relationships": [
        "contractor",
        "business"
      ],
      "effectiveFrom": "2026-01-01",
      "effectiveThrough": "2026-12-31",
      "parameters": {
        "reportingThresholdMinor": "200000"
      },
      "sources": [
        {
          "id": "irs-p15-2026",
          "title": "IRS Publication 15 (2026)",
          "url": "https://www.irs.gov/pub/irs-pdf/p15.pdf",
          "locator": "Sections 1 and 10; information-reporting threshold changes",
          "checkedAt": "2026-11-14",
          "documentSha256": "b46c3622439d8521e3a0faca4cd5b5ece3451b526f65f06a5e38d5c9f804c88b"
        }
      ],
      "limitations": [
        "Reporting trigger preparation only; no income/self-employment/backup withholding tax calculation or filing.",
        "Only reviewed reportable direct nonemployee-service payments to a US noncorporate payee; foreign payees, corporate exceptions, legal fees, platforms and payment cards require separate rules."
      ]
    },
    {
      "id": "ae-vat-standard-v1",
      "kind": "ae_vat",
      "jurisdictions": [
        "AE-MAINLAND",
        "AE-ADGM"
      ],
      "relationships": [
        "business",
        "contractor"
      ],
      "effectiveFrom": "2018-01-01",
      "effectiveThrough": "2026-12-31",
      "parameters": {
        "vatBps": 500
      },
      "sources": [
        {
          "id": "uae-vat",
          "title": "UAE Federal Tax Authority VAT FAQ",
          "url": "https://tax.gov.ae/en/faq.aspx?keyword=Does+VAT+apply+to+all+goods+and+services",
          "locator": "Standard rate and exempt/zero-rated exclusions",
          "checkedAt": "2026-11-14",
          "documentSha256": "88919ac9a07df0fdf4ed9675aec58526b171a0f9ec3bc757ec0f67eadbb51e48"
        },
        {
          "id": "uae-vat-introduction",
          "title": "UAE Ministry of Finance tax overview",
          "url": "https://mof.gov.ae/en/public-finance/tax/",
          "locator": "VAT introduction on 1 January 2018",
          "checkedAt": "2026-11-14",
          "documentSha256": "2ce535e7206c335d01fe7c9fd5fc82e3fc9db5ef58f871e48e20f6a0e14b0159"
        }
      ],
      "limitations": [
        "Only an explicitly reviewed domestic standard-rated, tax-exclusive supply by a registered supplier. No zero-rating, exemptions, reverse charge, designated-zone analysis or FX.",
        "ADGM employment rules do not make every ADGM supply VAT exempt. Corporate/personal taxes, registration thresholds and return obligations are not calculated."
      ]
    },
    {
      "id": "ae-mainland-gratuity-v1",
      "kind": "ae_mainland_gratuity",
      "jurisdictions": [
        "AE-MAINLAND"
      ],
      "relationships": [
        "employee"
      ],
      "effectiveFrom": "2022-02-02",
      "effectiveThrough": "2026-12-31",
      "parameters": {
        "firstYears": 5,
        "firstDaysPerYear": 21,
        "laterDaysPerYear": 30,
        "dailyDivisor": 30,
        "capMonths": 24
      },
      "sources": [
        {
          "id": "uae-labour-current",
          "title": "UAE Federal Decree-Law 33 of 2021",
          "url": "https://www.uaelegislation.gov.ae/en/legislations/1541/download",
          "locator": "Article 51: full-time foreign-worker end-of-service benefits",
          "checkedAt": "2026-11-14",
          "documentSha256": null
        }
      ],
      "limitations": [
        "Standard full-time foreign private-sector worker on the statutory gratuity path, with reviewed creditable service and no pension/savings substitution.",
        "Current consolidated primary-law bytes could not be downloaded; the reviewer must verify the current Article 51 before operational approval. Allowances, outstanding salary/leave, deductions and contractual enhancements are outside this component."
      ]
    },
    {
      "id": "ae-adgm-gratuity-v2024",
      "kind": "ae_adgm_gratuity",
      "jurisdictions": [
        "AE-ADGM"
      ],
      "relationships": [
        "employee"
      ],
      "effectiveFrom": "2025-04-01",
      "effectiveThrough": "2026-12-31",
      "parameters": {
        "firstYears": 5,
        "firstDaysPerYear": 21,
        "laterDaysPerYear": 30,
        "dailyDivisor": 365,
        "basicFloorBps": 5000
      },
      "sources": [
        {
          "id": "adgm-employment",
          "title": "ADGM EAO FAQ: Employment Regulations 2024",
          "url": "https://assets.adgm.com/download/assets/ADGM%20EAO%20-%20FAQs%20-%20ER%202024%20%28Feb%202025%29.pdf/eed10768edbe11ef9eaee2d468ad6a26",
          "locator": "February 2025 FAQ, sections B and M; pp. 21–23",
          "checkedAt": "2026-11-14",
          "documentSha256": "90fe70d6ec89b0365355c9b0c815c47370e4efadc01b88ffd18f87fcfddb8099"
        }
      ],
      "limitations": [
        "Standard full-time non-UAE/GCC employee on the statutory gratuity path. Use annual Basic Wage, with at least half of annual Wages for this calculation; do not reuse mainland monthly/30 assumptions.",
        "The October 2025 consolidated text was not retrievable. Before signing an operational review, compare the FAQ with current regulations and pension/savings/contract exceptions. No mainland 24-month cap is imported."
      ]
    }
  ],
  "engineSourceSha256": "0d1244fca9160064dc613e3d2ad092b3e5e4c8bd074cfe96310d4d3294e41784"
};
