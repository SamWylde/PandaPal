#!/usr/bin/env node
/**
 * Cardigann CLI Tool
 *
 * Commands:
 *   check  - Check for domain updates against Prowlarr
 *   sync   - Force sync definitions from Prowlarr
 *   report - Generate full domain comparison report
 *   auto   - Auto-update scraper files with latest domains
 *
 * Usage:
 *   node lib/cardigann/cli.js check
 *   npm run check-domains
 *   npm run auto-update-domains
 */

import { createDomainReport, refreshDefinitions, getAvailableIndexers, getUpdatedDomains } from './search.js';
import { autoUpdateDomains } from './autoupdate.js';

// Current domains in our scrapers (for comparison)
const CURRENT_DOMAINS = {
    yts: [
        'https://yts.mx/api/v2',
        'https://yts.lt/api/v2',
        'https://yts.am/api/v2'
    ],
    '1337x': [
        'https://1337x.to',
        'https://1337x.st',
        'https://www.1337xx.to',
        'https://x1337x.eu',
        'https://1337xto.to'
    ],
    torrentgalaxy: [
        'https://tgx.rs',
        'https://torrentgalaxy.one',
        'https://torrentgalaxy.to',
        'https://torrentgalaxy.mx'
    ],
    eztv: [
        'https://eztvx.to/api'
    ],
    nyaa: [
        'https://nyaa.si'
    ]
};

async function main() {
    const command = process.argv[2] || 'check';

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Cardigann Domain Checker / Sync Tool               ║');
    console.log('║  Source: https://github.com/Prowlarr/Indexers              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    try {
        switch (command) {
            case 'check':
                await checkDomains();
                break;
            case 'sync':
                await syncDefinitions();
                break;
            case 'report':
                await generateReport();
                break;
            case 'auto':
            case 'update':
                await runAutoUpdate();
                break;
            default:
                console.log('Unknown command. Available commands: check, sync, report, auto');
                process.exit(1);
        }
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

async function checkDomains() {
    console.log('Checking for domain updates...\n');

    const report = await createDomainReport(CURRENT_DOMAINS);

    let hasUpdates = false;

    for (const [name, data] of Object.entries(report.indexers)) {
        const status = data.needsUpdate ? '⚠️  NEEDS UPDATE' : '✅ Up to date';

        console.log(`┌─ ${name.toUpperCase()} ${status}`);

        if (data.added.length > 0) {
            console.log(`│  + New domains from Prowlarr:`);
            data.added.forEach(d => console.log(`│      + ${d}`));
            hasUpdates = true;
        }

        if (data.removed.length > 0) {
            console.log(`│  - Domains not in Prowlarr (may be outdated):`);
            data.removed.forEach(d => console.log(`│      - ${d}`));
            hasUpdates = true;
        }

        if (data.prowlarr.length > 0) {
            console.log(`│  Current Prowlarr domains (${data.prowlarr.length}):`);
            data.prowlarr.slice(0, 5).forEach(d => console.log(`│      ${d}`));
            if (data.prowlarr.length > 5) {
                console.log(`│      ... and ${data.prowlarr.length - 5} more`);
            }
        }

        console.log('└─');
        console.log('');
    }

    console.log(`Last sync: ${report.lastSync || 'Never'}`);
    console.log(`Source: ${report.source || 'Unknown'}`);

    if (hasUpdates) {
        console.log('\n⚠️  Some indexers have domain updates available.');
        console.log('   Run `npm run domain-report` for full details.');
    } else {
        console.log('\n✅ All domains are up to date with Prowlarr.');
    }
}

async function syncDefinitions() {
    console.log('Force syncing definitions from Prowlarr...\n');

    const metadata = await refreshDefinitions();

    console.log('Sync complete!\n');
    console.log(`Synced: ${Object.keys(metadata.indexers).length} indexers`);
    console.log(`Timestamp: ${metadata.lastSync}`);
    console.log(`Source: ${metadata.source}`);
    console.log(`Version: ${metadata.version}`);

    console.log('\nIndexers synced:');
    for (const [id, info] of Object.entries(metadata.indexers)) {
        console.log(`  - ${id}: ${info.links?.length || 0} domains`);
    }
}

async function runAutoUpdate() {
    console.log('Auto-updating scraper files with latest domains...\n');

    const dryRun = process.argv.includes('--dry-run');
    if (dryRun) {
        console.log('(DRY RUN - no files will be modified)\n');
    }

    const results = await autoUpdateDomains({ dryRun, verbose: true });

    console.log('\n' + '='.repeat(60));
    if (results.updated.length > 0 && !dryRun) {
        console.log('✅ Scraper files have been updated!');
        console.log('   Updated indexers:', results.updated.map(u => u.indexerId).join(', '));
        console.log('\n   Remember to commit the changes:');
        console.log('   git add scraper/lib/sources/*.js');
        console.log('   git commit -m "chore: auto-update scraper domains from Prowlarr"');
    } else if (results.updated.length > 0 && dryRun) {
        console.log('🔍 Would update:', results.updated.map(u => u.indexerId).join(', '));
        console.log('   Run without --dry-run to apply changes');
    } else {
        console.log('✅ All scraper files are already up to date!');
    }
    console.log('='.repeat(60));
}

async function generateReport() {
    console.log('Generating full domain comparison report...\n');

    const report = await createDomainReport(CURRENT_DOMAINS);

    console.log('='.repeat(60));
    console.log('DOMAIN UPDATE REPORT');
    console.log('='.repeat(60));
    console.log(`Generated: ${report.timestamp}`);
    console.log(`Source: ${report.source}`);
    console.log(`Last Sync: ${report.lastSync}`);
    console.log('='.repeat(60));
    console.log('');

    for (const [name, data] of Object.entries(report.indexers)) {
        console.log(`\n### ${name.toUpperCase()} ###`);
        console.log('-'.repeat(40));

        console.log('\nCurrent (hardcoded):');
        if (data.current.length === 0) {
            console.log('  (none)');
        } else {
            data.current.forEach(d => console.log(`  ${d}`));
        }

        console.log('\nProwlarr (latest):');
        if (data.prowlarr.length === 0) {
            console.log('  (none synced)');
        } else {
            data.prowlarr.forEach(d => console.log(`  ${d}`));
        }

        if (data.needsUpdate) {
            console.log('\n⚠️  ACTION REQUIRED:');
            if (data.added.length > 0) {
                console.log('  Add these domains:');
                data.added.forEach(d => console.log(`    + ${d}`));
            }
            if (data.removed.length > 0) {
                console.log('  Consider removing (not in Prowlarr):');
                data.removed.forEach(d => console.log(`    - ${d}`));
            }
        } else {
            console.log('\n✅ No updates needed');
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('To update scraper files, edit:');
    console.log('  - scraper/lib/sources/yts.js');
    console.log('  - scraper/lib/sources/t1337x.js');
    console.log('  - scraper/lib/sources/torrentgalaxy.js');
    console.log('  - scraper/lib/sources/eztv.js');
    console.log('  - scraper/lib/sources/nyaa.js');
    console.log('='.repeat(60));
}

// Run
main().catch(console.error);
