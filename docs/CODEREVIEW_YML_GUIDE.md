# .codereview.yml Configuration Guide

Complete guide to customizing AI code reviews for your repository.

## Quick Start

1. Copy the starter template to your repository root:
   ```bash
   cp .codereview.yml.starter .codereview.yml
   ```

2. Customize for your project:
   - Set your tech stack
   - Add custom rules
   - Configure ignore patterns

3. Commit and push - the AI will use your configuration on the next PR!

## Configuration Sections

### 1. Tech Stack

Override automatic detection with explicit configuration:

```yaml
stack:
  language: typescript        # Primary language
  framework: nextjs          # Framework
  architecture: fsd          # Architecture pattern
  ecosystem:                 # Libraries
    - react-hook-form
    - tanstack-query
```

**Supported Values**:
- **Languages**: `typescript`, `python`, `go`
- **Frameworks**: `nextjs`, `react`, `express`
- **Architecture**: `fsd` (Feature-Sliced Design)
- **Ecosystem**: `react-hook-form`, `tanstack-query`, `zustand`, `tailwind`

### 2. Custom Rules

Define project-specific rules:

```yaml
rules:
  - category: security
    title: "No hardcoded API keys"
    description: "Use environment variables"
    severity: critical
    pattern: "Optional regex pattern"
```

**Categories**: `security`, `performance`, `clean-code`, `testing`, `documentation`  
**Severities**: `critical`, `high`, `medium`, `low`

### 3. Severity Overrides

Adjust default severity levels:

```yaml
severity:
  "console.log usage": critical
  "Untracked TODO comment": low
  "Missing error handling": critical
```

### 4. Ignore Patterns

Exclude files from review:

```yaml
ignore:
  - "dist/**"
  - "**/*.generated.ts"
  - "node_modules/**"
```

Uses glob patterns - `**` for recursive matching.

### 5. Focus Areas

Highlight critical code:

```yaml
focus:
  - path: "src/auth/**"
    reason: "Security critical"
    severity: critical
```

### 6. Review Preferences

Customize review behavior:

```yaml
preferences:
  verbosity: normal              # concise, normal, detailed
  include_suggestions: true      # Include code suggestions
  include_examples: true         # Include examples
  max_findings_per_file: 10     # Limit findings per file
  min_severity: low             # Minimum severity to report
```

### 7. Team Standards

Document coding standards:

```yaml
standards:
  naming:
    - "Use camelCase for variables"
    - "Use PascalCase for components"
  error_handling:
    - "Always use try-catch for async"
    - "Log errors with context"
```

### 8. Integration Settings

Control workflow integration:

```yaml
integration:
  auto_approve:
    - "**/*.md"
  block_on_critical: true
  block_threshold:
    high: 5
    critical: 1
  inline_comments:
    - critical
    - high
```

### 9. Examples

Provide good/bad code examples:

```yaml
examples:
  good:
    - description: "Proper error handling"
      code: |
        try {
          await operation();
        } catch (error) {
          logger.error('Failed', { error });
          throw new CustomError('Operation failed');
        }
  
  bad:
    - description: "Poor error handling"
      code: |
        try {
          await operation();
        } catch (error) {
          console.log(error); // Bad!
        }
```

## Common Configurations

### React/Next.js Project

```yaml
stack:
  language: typescript
  framework: nextjs
  ecosystem:
    - react-hook-form
    - tanstack-query
    - tailwind

rules:
  - category: performance
    title: "Lazy load heavy components"
    severity: medium

ignore:
  - ".next/**"
  - "out/**"
```

### Node.js API

```yaml
stack:
  language: typescript
  framework: express

rules:
  - category: security
    title: "Validate all inputs"
    severity: critical
  
  - category: performance
    title: "Use database indexes"
    severity: high

ignore:
  - "dist/**"
  - "coverage/**"
```

### Python Project

```yaml
stack:
  language: python

rules:
  - category: clean-code
    title: "Follow PEP 8"
    severity: medium
  
  - category: testing
    title: "Use pytest fixtures"
    severity: low

ignore:
  - "**/__pycache__/**"
  - "*.pyc"
  - "venv/**"
```

## Best Practices

### 1. Start Simple
Begin with minimal configuration and add rules as needed:
```yaml
stack:
  language: typescript
  framework: nextjs

ignore:
  - "dist/**"
  - "node_modules/**"
```

### 2. Focus on Critical Areas
Use `focus` for security-critical code:
```yaml
focus:
  - path: "src/auth/**"
    reason: "Authentication logic"
    severity: critical
```

### 3. Document Team Standards
Make implicit knowledge explicit:
```yaml
standards:
  naming:
    - "Prefix boolean variables with is/has/should"
  testing:
    - "Write tests before fixing bugs"
```

### 4. Adjust Severities
Tune to your team's priorities:
```yaml
severity:
  "Missing tests": high          # Your team values testing
  "console.log usage": critical  # Enforce proper logging
```

### 5. Provide Examples
Help the AI understand your preferences:
```yaml
examples:
  good:
    - description: "Our error handling pattern"
      code: |
        // Your team's preferred pattern
```

## Troubleshooting

### Configuration Not Applied

**Problem**: Changes to `.codereview.yml` not reflected in reviews

**Solutions**:
1. Ensure file is in repository root
2. Check YAML syntax (use a validator)
3. Commit and push the file
4. Create a new PR to test

### Too Many Findings

**Problem**: Reviews are overwhelming

**Solutions**:
```yaml
preferences:
  max_findings_per_file: 5
  min_severity: medium
```

### Missing Important Issues

**Problem**: Critical issues not caught

**Solutions**:
```yaml
rules:
  - category: security
    title: "Your specific concern"
    severity: critical

focus:
  - path: "critical/path/**"
    severity: critical
```

## Examples by Use Case

### Startup (Move Fast)
```yaml
preferences:
  verbosity: concise
  min_severity: high

ignore:
  - "**/*.test.ts"  # Skip test files
```

### Enterprise (Strict Standards)
```yaml
preferences:
  verbosity: detailed
  min_severity: low

integration:
  block_on_critical: true
  block_threshold:
    high: 3
    critical: 1
```

### Open Source (Community Standards)
```yaml
rules:
  - category: documentation
    title: "Public APIs must be documented"
    severity: high

standards:
  documentation:
    - "Use JSDoc for all exports"
    - "Include usage examples"
```

## Schema Reference

See `.codereview.yml.example` for complete schema with all options.

## Support

- **Documentation**: See `docs/CONFIGURATION.md`
- **Examples**: See `.codereview.yml.example` and `.codereview.yml.starter`
- **Issues**: Check GitHub issues or create a new one

---

**Last Updated**: April 20, 2026  
**Version**: 1.0.0
