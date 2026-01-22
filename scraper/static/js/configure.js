/**
 * PandaPal Configuration Page Logic
 * 
 * Handles form interactions, multiselect initialization, and install link generation.
 * This file is loaded by the configuration page and expects certain global variables
 * to be set by the template (CONFIG object).
 */

(function ($) {
    'use strict';

    // ==========================================================================
    // Configuration (Injected by Template)
    // ==========================================================================

    // The template will inject a CONFIG object before this script loads:
    // window.PANDAPAL_CONFIG = {
    //   providers: { key: 'providers', options: [...] },
    //   sortOptions: { key: 'sort', options: {...} },
    //   mochOptions: { realdebrid: {...}, premiumize: {...}, ... },
    //   qualityFilter: { key: 'qualityfilter' },
    //   sizeFilter: { key: 'sizefilter' },
    //   forceIncludeExcluded: { key: 'force_include_excluded' },
    //   languageOptions: { key: 'language' },
    //   debridOptions: { key: 'debridoptions' },
    //   preConfigurations: { lite: '...', brazuca: '...' },
    //   initialValues: { providers: [...], catalogs: [...], ... }
    // };

    const CONFIG = window.PANDAPAL_CONFIG || {};

    // ==========================================================================
    // DOM Element References (Cached for Performance)
    // ==========================================================================

    const elements = {
        // Will be populated on init
    };

    // ==========================================================================
    // Multiselect Configuration
    // ==========================================================================

    /**
     * Shared buttonText formatter for multiselects
     * Shows "None", single item name, or "X selected"
     */
    function formatButtonText(options, select) {
        const emptyText = $(select).data('empty-text') || 'None';

        if (options.length === 0) {
            return emptyText;
        }

        if (options.length === 1) {
            const label = options.first().attr('label') || options.first().text();
            return label;
        }

        return options.length + ' selected';
    }

    /**
     * Creates a multiselect with consistent configuration
     */
    function initMultiselect(selector, customOptions) {
        const defaults = {
            maxHeight: 400,
            buttonTextAlignment: 'left',
            buttonText: formatButtonText,
            onChange: function () {
                generateInstallLink();
            }
        };

        const options = $.extend({}, defaults, customOptions);
        $(selector).multiselect(options);
    }

    /**
     * Pre-select values in a multiselect
     */
    function selectMultiselectValues(selector, values) {
        if (values && values.length > 0) {
            $(selector).multiselect('select', values);
        }
    }

    // ==========================================================================
    // Debrid Provider Logic
    // ==========================================================================

    /**
     * Show/hide debrid-specific fields based on selected provider
     */
    function handleDebridProviderChange() {
        const provider = elements.debridProviders.val();

        // Hide all debrid sections first
        $('.debrid-section').removeClass('is-visible');

        // Show/hide debrid options (visible when any provider selected)
        if (provider && provider !== 'none') {
            elements.debridOptionsSection.addClass('is-visible');
            // Show the relevant API key section using lowercase ID
            $('#d' + provider).addClass('is-visible');
        }

        generateInstallLink();
    }

    /**
     * Update label text based on sort mode
     */
    function handleSortModeChange() {
        const sortValue = elements.sort.val();
        const sortOptions = CONFIG.sortOptions?.options || {};

        // Check if current sort mode should show "Max results" vs "Max results per quality"
        if (sortValue === sortOptions.seeders?.key || sortValue === sortOptions.size?.key) {
            elements.limitLabel.text('Max results:');
        } else {
            elements.limitLabel.text('Max results per quality:');
        }

        generateInstallLink();
    }

    // ==========================================================================
    // Install Link Generation
    // ==========================================================================

    /**
     * Safely get value from multiselect
     */
    function getMultiselectValue(selector) {
        return ($(selector).val() || []).join(',');
    }

    /**
     * Safely get text input value
     */
    function getInputValue(selector) {
        const el = $(selector);
        return el.length ? (el.val() || '').trim() : '';
    }

    /**
     * Safely get checkbox value
     */
    function getCheckboxValue(selector) {
        return $(selector).prop('checked') || false;
    }

    /**
     * Generate the Stremio install link based on current form values
     */
    function generateInstallLink() {
        const keys = {
            providers: CONFIG.providers?.key || 'providers',
            sort: CONFIG.sortOptions?.key || 'sort',
            language: CONFIG.languageOptions?.key || 'language',
            qualityFilter: CONFIG.qualityFilter?.key || 'qualityfilter',
            forceInclude: CONFIG.forceIncludeExcluded?.key || 'force_include_excluded',
            sizeFilter: CONFIG.sizeFilter?.key || 'sizefilter',
            debridOptions: CONFIG.debridOptions?.key || 'debridoptions'
        };

        const moch = CONFIG.mochOptions || {};
        const preConfigs = CONFIG.preConfigurations || {};
        const providerCount = CONFIG.providers?.options?.length || 0;

        // Gather all form values
        const values = {
            catalogs: getMultiselectValue('#iCatalogs'),
            rpdb: getInputValue('#iRpdb'),
            trakt: getInputValue('#iTrakt'),
            providers: getMultiselectValue('#iProviders'),
            sort: getInputValue('#iSort'),
            languages: getMultiselectValue('#iLanguages'),
            qualityFilter: getMultiselectValue('#iQualityFilter'),
            forceIncludeExcluded: getCheckboxValue('#iForceIncludeExcluded'),
            limit: getInputValue('#iLimit'),
            sizeFilter: getInputValue('#iSizeFilter'),
            debridOptions: getMultiselectValue('#iDebridOptions'),
            realDebrid: getInputValue('#iRealDebrid'),
            premiumize: getInputValue('#iPremiumize'),
            allDebrid: getInputValue('#iAllDebrid'),
            debridLink: getInputValue('#iDebridLink'),
            easyDebrid: getInputValue('#iEasyDebrid'),
            offcloud: getInputValue('#iOffcloud'),
            torbox: getInputValue('#iTorbox'),
            putioClientId: getInputValue('#iPutioClientId'),
            putioToken: getInputValue('#iPutioToken')
        };

        // Build configuration array (only include non-empty/non-default values)
        const providersList = values.providers.split(',').filter(Boolean);
        const defaultSort = CONFIG.sortOptions?.options?.qualitySeeders?.key;

        const configParts = [];

        // Catalogs
        if (values.catalogs) {
            configParts.push(['catalogs', values.catalogs]);
        }

        // RPDB
        if (values.rpdb) {
            configParts.push(['rpdb', values.rpdb]);
        }

        // Trakt
        if (values.trakt) {
            configParts.push(['trakt', values.trakt]);
        }

        // Providers (only if not all selected)
        if (providersList.length > 0 && providersList.length < providerCount) {
            configParts.push([keys.providers, values.providers]);
        }

        // Sort (only if not default)
        if (values.sort && values.sort !== defaultSort) {
            configParts.push([keys.sort, values.sort]);
        }

        // Languages
        if (values.languages) {
            configParts.push([keys.language, values.languages]);
        }

        // Quality Filter
        if (values.qualityFilter) {
            configParts.push([keys.qualityFilter, values.qualityFilter]);
        }

        // Force Include Excluded
        if (values.forceIncludeExcluded) {
            configParts.push([keys.forceInclude, 'true']);
        }

        // Limit (validate it's a reasonable number)
        if (values.limit && /^[1-9][0-9]{0,2}$/.test(values.limit)) {
            configParts.push(['limit', values.limit]);
        }

        // Size Filter
        if (values.sizeFilter) {
            configParts.push([keys.sizeFilter, values.sizeFilter]);
        }

        // Debrid Options
        if (values.debridOptions) {
            configParts.push([keys.debridOptions, values.debridOptions]);
        }

        // Debrid API Keys
        if (values.realDebrid && moch.realdebrid) {
            configParts.push([moch.realdebrid.key, values.realDebrid]);
        }
        if (values.premiumize && moch.premiumize) {
            configParts.push([moch.premiumize.key, values.premiumize]);
        }
        if (values.allDebrid && moch.alldebrid) {
            configParts.push([moch.alldebrid.key, values.allDebrid]);
        }
        if (values.debridLink && moch.debridlink) {
            configParts.push([moch.debridlink.key, values.debridLink]);
        }
        if (values.easyDebrid && moch.easydebrid) {
            configParts.push([moch.easydebrid.key, values.easyDebrid]);
        }
        if (values.offcloud && moch.offcloud) {
            configParts.push([moch.offcloud.key, values.offcloud]);
        }
        if (values.torbox && moch.torbox) {
            configParts.push([moch.torbox.key, values.torbox]);
        }
        if (values.putioClientId && values.putioToken && moch.putio) {
            configParts.push([moch.putio.key, values.putioClientId + '@' + values.putioToken]);
        }

        // Build configuration string
        let configValue = configParts
            .filter(([_, value]) => value && value.length > 0)
            .map(([key, value]) => key + '=' + value)
            .join('|');

        // Check if this matches a pre-configuration
        for (const [preKey, preValue] of Object.entries(preConfigs)) {
            if (preValue === configValue) {
                configValue = preKey;
                break;
            }
        }

        // Generate final URL
        const configuration = configValue ? '/' + configValue : '';
        const manifestUrl = window.location.host + configuration + '/manifest.json';

        elements.installLink.attr('href', 'stremio://' + manifestUrl);
    }

    // ==========================================================================
    // Clipboard
    // ==========================================================================

    /**
     * Copy install link to clipboard when install button is clicked
     */
    function handleInstallClick() {
        const href = elements.installLink.attr('href') || '';
        const httpsUrl = href.replace('stremio://', 'https://');

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(httpsUrl);
        }
    }

    // ==========================================================================
    // Utilities
    // ==========================================================================

    function capitalizeFirst(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // ==========================================================================
    // Initialization
    // ==========================================================================

    function cacheElements() {
        elements.installLink = $('#installLink');
        elements.debridProviders = $('#iDebridProviders');
        elements.debridOptionsSection = $('#ddebridoptions');
        elements.sort = $('#iSort');
        elements.limitLabel = $('#iLimitLabel');
    }

    function initMultiselects() {
        const initial = CONFIG.initialValues || {};

        // Catalogs
        initMultiselect('#iCatalogs', {
            nonSelectedText: 'All catalogs',
            buttonText: function (options, select) {
                if (options.length === 0) return 'All catalogs';
                if (options.length === 1) return options.first().text();
                return options.length + ' selected';
            }
        });
        selectMultiselectValues('#iCatalogs', initial.catalogs);

        // Providers
        initMultiselect('#iProviders', {
            nonSelectedText: 'All providers',
            buttonText: function (options, select) {
                if (options.length === 0) return 'All providers';
                if (options.length === 1) return options.first().text();
                return options.length + ' selected';
            }
        });
        selectMultiselectValues('#iProviders', initial.providers);

        // Languages
        initMultiselect('#iLanguages', { nonSelectedText: 'None' });
        selectMultiselectValues('#iLanguages', initial.languages);

        // Quality Filter
        initMultiselect('#iQualityFilter', { nonSelectedText: 'None' });
        selectMultiselectValues('#iQualityFilter', initial.qualityFilters);

        // Debrid Options
        initMultiselect('#iDebridOptions', { nonSelectedText: 'None' });
        selectMultiselectValues('#iDebridOptions', initial.debridOptions);
    }

    function setInitialValues() {
        const initial = CONFIG.initialValues || {};

        // Regular inputs
        $('#iDebridProviders').val(initial.debridProvider || 'none');
        $('#iRealDebrid').val(initial.realDebridApiKey || '');
        $('#iPremiumize').val(initial.premiumizeApiKey || '');
        $('#iAllDebrid').val(initial.allDebridApiKey || '');
        $('#iDebridLink').val(initial.debridLinkApiKey || '');
        $('#iEasyDebrid').val(initial.easyDebridApiKey || '');
        $('#iOffcloud').val(initial.offcloudApiKey || '');
        $('#iTorbox').val(initial.torboxApiKey || '');
        $('#iPutioClientId').val(initial.putioClientId || '');
        $('#iPutioToken').val(initial.putioToken || '');
        $('#iSort').val(initial.sort || '');
        $('#iLimit').val(initial.limit || '');
        $('#iSizeFilter').val(initial.sizeFilter || '');
        $('#iRpdb').val(initial.rpdb || '');
        $('#iTrakt').val(initial.trakt || '');

        // Checkbox
        $('#iForceIncludeExcluded').prop('checked', initial.forceIncludeExcluded || false);
    }

    function bindEvents() {
        // Debrid provider change
        elements.debridProviders.on('change', handleDebridProviderChange);

        // Sort mode change
        elements.sort.on('change', handleSortModeChange);

        // All other inputs trigger link regeneration
        $(document).on('change', '.form-input, .form-select', generateInstallLink);
        $(document).on('change', '.checkbox-input', generateInstallLink);
        $(document).on('input', '.form-input[type="text"]', generateInstallLink);

        // Install button click
        elements.installLink.on('click', handleInstallClick);
    }

    function init() {
        cacheElements();
        initMultiselects();
        setInitialValues();
        bindEvents();
        handleDebridProviderChange();
        generateInstallLink();
    }

    // Start when DOM is ready
    $(document).ready(init);

})(jQuery);
