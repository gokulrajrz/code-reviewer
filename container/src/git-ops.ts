import { execa } from 'execa';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shallow-clone the PR's head commit into the work directory.
 * Uses the GitHub App installation token for authentication.
 */
export async function cloneRepository(
	repoFullName: string,
	headSha: string,
	installationToken: string,
	workDir: string
): Promise<void> {
	const cloneUrl = `https://x-access-token:${installationToken}@github.com/${repoFullName}.git`;

	// Shallow clone the default branch first
	await execa('git', ['clone', '--depth=50', '--single-branch', cloneUrl, workDir], {
		timeout: 60_000, // 60s timeout for large repos
		env: {
			GIT_TERMINAL_PROMPT: '0', // Never prompt for credentials
		},
	});

	// Fetch the specific PR head commit so we can diff against it
	await execa('git', ['fetch', 'origin', headSha, '--depth=50'], {
		cwd: workDir,
		timeout: 30_000,
	});

	// Checkout the PR head
	await execa('git', ['checkout', headSha], {
		cwd: workDir,
		timeout: 10_000,
	});
}

/**
 * Get the list of files changed between the PR head and the merge base.
 * Returns relative file paths within the repository.
 */
export async function getChangedFiles(workDir: string): Promise<string[]> {
	// Find the merge base between HEAD and the default branch
	let mergeBase: string;
	try {
		const result = await execa('git', ['merge-base', 'HEAD', 'origin/HEAD'], {
			cwd: workDir,
			timeout: 10_000,
		});
		mergeBase = result.stdout.trim();
	} catch {
		// Fallback: diff against HEAD~1 if merge-base discovery fails
		mergeBase = 'HEAD~1';
	}

	// Get changed file names
	const result = await execa('git', ['diff', '--name-only', '--diff-filter=ACMRT', mergeBase, 'HEAD'], {
		cwd: workDir,
		timeout: 10_000,
	});

	return result.stdout
		.split('\n')
		.map((f) => f.trim())
		.filter((f) => f.length > 0)
		.filter((f) => isReviewableFile(f));
}

/**
 * Get the full diff content for a specific file.
 */
export async function getFileDiff(workDir: string, filePath: string): Promise<string> {
	let mergeBase: string;
	try {
		const result = await execa('git', ['merge-base', 'HEAD', 'origin/HEAD'], {
			cwd: workDir,
			timeout: 10_000,
		});
		mergeBase = result.stdout.trim();
	} catch {
		mergeBase = 'HEAD~1';
	}

	const result = await execa('git', ['diff', mergeBase, 'HEAD', '--', filePath], {
		cwd: workDir,
		timeout: 10_000,
	});
	return result.stdout;
}

/**
 * Check if a file is worth reviewing (not generated, not binary, not vendor).
 */
function isReviewableFile(filename: string): boolean {
	const skipPatterns = [
		/^node_modules\//,
		/^vendor\//,
		/^dist\//,
		/^build\//,
		/^\.next\//,
		/^coverage\//,
		/\.min\.(js|css)$/,
		/\.map$/,
		/\.lock$/,
		/package-lock\.json$/,
		/yarn\.lock$/,
		/pnpm-lock\.yaml$/,
		/\.generated\./,
		/\.snap$/,
		/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i,
		/\.(mp4|webm|mp3|wav)$/i,
		/\.(zip|tar|gz|bz2)$/i,
		/\.(pdf|doc|docx|xls|xlsx)$/i,
	];
	return !skipPatterns.some((pattern) => pattern.test(filename));
}

/**
 * Clean up the temporary clone directory.
 */
export async function cleanup(workDir: string): Promise<void> {
	try {
		await rm(workDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the container is ephemeral anyway
	}
}
