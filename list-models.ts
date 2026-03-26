import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

function loadEnvFromDevVars(): void {
  const devVarsPath = path.join(process.cwd(), '.dev.vars');
  if (!fs.existsSync(devVarsPath)) {
    console.error('Error: .dev.vars file not found');
    process.exit(1);
  }

  const content = fs.readFileSync(devVarsPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex);
    let value = trimmed.slice(equalIndex + 1);

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function listModels() {
  loadEnvFromDevVars();

  const client = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });

  const models = [];
  for await (const modelInfo of client.models.list()) {
    models.push(modelInfo);
  }
  console.log(JSON.stringify({ data: models }, null, 2));
}

listModels();
