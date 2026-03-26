# 3-Level Chunking & Context Architecture TODO List

This document outlines all necessary steps to implement the advanced 3-level chunking and context pipeline for the AI Code Reviewer. 

---

## 🏗️ Phase 1: Level 1 & Level 2 Chunking (File & Hunk Based)
> **Goal:** Fetch PR changes, split by file, and intelligently expand hunks to preserve context.

- [ ] **1. File Classification Engine**
  - Extract the PR diff.
  - Implement strict filters for noise files (lock files, minified files, generated files).
  - Treat each valid file as an independent unit for level 1 chunking.

- [ ] **2. Git Patch Parser**
  - Parse the GitHub diff strings (`@@ -10,6 +10,10 @@`) to isolate hunks within the file.

- [ ] **3. Smart Hunk Context Expansion**
  - Fetch the entire raw file source for the changed file (handling Cloudflare 302 redirects).
  - Inject exactly 20-50 lines BEFORE the changed hunk.
  - Inject exactly 20-50 lines AFTER the changed hunk.
  - Consolidate overlapping hunks if the expanded lines intersect.

---

## ⚡ Phase 2: Level 3 Token-Based Safety Layer
> **Goal:** Ensure expanded hunks and massive files safely fit within the 20k-40k token window without breaking logical blocks.

- [ ] **4. Token Estimation / Counting**
  - Implement a token counter to estimate the size of the expanded hunk.
  - Define the `MAX_CHUNK_SIZE` limit tightly (between 20k - 40k).

- [ ] **5. Logical Block Splitter (Fallback Mechanism)**
  - If an expanded hunk exceeds the limit, split it intelligently.
  - Build a lightweight regex-based scanner to split strictly at boundaries: `function`, `class`, or `export` keywords.
  - Avoid splitting in the middle of a continuous block if possible.

---

## 🧩 Phase 3: Advanced Context Injection
> **Goal:** Supply dependency contexts to prevent "hallucinations" about imported utilities.

- [ ] **6. Dependency Extraction (Imports)**
  - Use regex to scan the expanded chunk for `import` statements (e.g., `import { validateUser } from "@/utils/auth"`).
  
- [ ] **7. Intelligent Dependency Fetching**
  - **Constraint Warning:** *Cloudflare Workers have a 50 subrequests limit. Fetching dependencies naively will exhaust this.*
  - **Action Item:** Download the repo structure as a single `.zip` (via GitHub Archive API) into memory, unzip, and extract dependency snippet contents dynamically. This completely bypasses the subrequest limit!
  - Append the dependency definitions (`validateUser`) to the chunk prompt.

- [ ] **8. File Metadata Injection**
  - Prepend a JSON metadata block to every chunk layout:
    ```json
    {
      "file": "auth/login.ts",
      "language": "typescript",
      "change_type": "modified"
    }
    ```

---

## 🧠 Phase 4: Cross-Chunk Awareness & Architecture Update
> **Goal:** Solve the context loss between chunks and define specific LLM provider roles.

- [ ] **9. Pass 1: Parallel Chunk Mapping (Sonnet 3.5 / 4.6)**
  - Fire the LLM calls across all chunks in **parallel**.
  - **Model:** Route these chunk calls specifically to Claude 3.5 Sonnet (or equivalent fast/reasoning model).
  - **Schema Update:** The output schema must be updated to return an explicit summary format:
    ```json
    {
      "findings": [...],
      "previous_findings": [
        "Auth logic missing validation",
        "Token not sanitized"
      ]
    }
    ```

- [ ] **10. Pass 2: Final Aggregation Layer (Opus - Optional/Premium)**
  - Collect all `previous_findings` summaries and all raw `findings` arrays.
  - **Model:** Route this aggregation pass ideally to Claude 3 Opus (or configure a fallback if not available).
  - The aggregator will see the narrative of the entire PR in a single context window.
  
- [ ] **11. Intelligent Deduplication Engine**
  - In the Aggregation Layer, cross-reference issues reported by independent chunks.
  - Output strict classification: Deduplicated issues and Severity classification.

- [ ] **12. Final PR Comment Output**
  - Map the final deduplicated review into a beautifully formatted Markdown comment.
  - Output actionable issues clearly categorized by severity.
