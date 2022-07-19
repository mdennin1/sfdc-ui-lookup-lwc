import { LightningElement, api, track, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { getRecords } from 'lightning/uiRecordApi';

const SEARCH_DELAY = 300; // Wait 300 ms after user stops typing then, peform search

const KEY_ARROW_UP = 38;
const KEY_ARROW_DOWN = 40;
const KEY_ENTER = 13;

const VARIANT_LABEL_STACKED = 'label-stacked';
const VARIANT_LABEL_INLINE = 'label-inline';
const VARIANT_LABEL_HIDDEN = 'label-hidden';

const REGEX_SOSL_RESERVED = /(\?|&|\||!|\{|\}|\[|\]|\(|\)|\^|~|\*|:|"|\+|-|\\)/g;
const REGEX_EXTRA_TRAP = /(\$|\\)/g;

export default class Lookup extends NavigationMixin(LightningElement) {
    // Public properties
    @api variant = VARIANT_LABEL_STACKED;
    @api label = '';
    @api required = false;
    @api disabled = false;
    @api placeholder = '';
    @api isMultiEntry = false;
    @api errors = [];
    @api scrollAfterNItems = null;
    @api newRecordOptions = [];
    @api minSearchTermLength = 2;
    @api title = 'Name';
    @api subtitle;
    @api icon;
    @api wireDefaultOptions;

    // Template properties
    searchResultsLocalState;
    loading = false;

    // Private properties
    _hasFocus = false;
    _isDirty = false;
    _searchTerm = '';
    _cleanSearchTerm;
    _cancelBlur = false;
    _searchThrottlingTimeout;
    _searchResults;
    _defaultSearchResults;
    _curSelection;
    _focusedResultIndex = null;
    _fields;
    @track recordsParam;

    // PUBLIC FUNCTIONS AND GETTERS/SETTERS
    @api
    get fields(){
      return this._fields?.filter((field, index) => index <= 1) ?? [this.title, this.subtitle]?.filter(value => !!value);
    }
    set fields(value){
      switch(typeof(value)){
        case 'string':
          this._fields = value?.split(',')?.map(field => field.trim());
          break;
        case 'object':
          if(Array.isArray(value)) this._fields = value?.map(field => field?.trim());
          break;
        default:
          break;
      }
    }
    @api 
    get options(){
      return this._searchResults ?? this._defaultSearchResults; //this.searchResultsLocalState;
    }
    set options(value){
      value = Array.isArray(value) ? value : [value];
      this.setDefaultResults(value);
    }
    @api
    set selection(initialSelection) {
        let selection;
        switch(typeof(initialSelection)){
          case 'string':
            initialSelection = initialSelection?.split?.(';');
            const options = this._searchResults ?? this._defaultSearchResults;
            selection = options?.length ? options?.filter(({id}) => initialSelection.includes(id)) : initialSelection;
            break;
          case 'object':
            selection = Array.isArray(initialSelection) ? initialSelection : [initialSelection];
            break;
          default:
            selection = initialSelection;
            break;
        }
        this._curSelection = selection;
        this.processSelectionUpdate(false);
    }
    get selection() {
        return this._curSelection;
    }
    
    @api
    setSearchResults(results) {
        // Reset the spinner
        this.loading = false;
        // Clone results before modifying them to avoid Locker restriction
        let resultsLocal = JSON.parse(JSON.stringify(results));
        // Remove selected items from search results
        const selectedIds = this._curSelection?.filter(sel => !!sel?.id)?.map((sel) => sel.id) ?? [];
        if(selectedIds?.length){
          resultsLocal = resultsLocal?.filter(({id}) => selectedIds?.indexOf(id) === -1);
        }
        // Format results
        const cleanSearchTerm = this._searchTerm.replace(REGEX_SOSL_RESERVED, '.?').replace(REGEX_EXTRA_TRAP, '\\$1');
        const regex = new RegExp(`(${cleanSearchTerm})`, 'gi');
        this._searchResults = resultsLocal?.map((result) => {
            // Format title and subtitle
            if (this._searchTerm?.length > 0 && !!result) {
                result.titleFormatted = result?.title
                    ? result?.title?.replace(regex, '<strong>$1</strong>')
                    : result?.title;
                result.subtitleFormatted = result?.subtitle
                    ? result?.subtitle?.replace(regex, '<strong>$1</strong>')
                    : result?.subtitle;
            } else {
                result.titleFormatted = result?.title;
                result.subtitleFormatted = result?.subtitle;
            }
            // Add icon if missing
            if (typeof result.icon === 'undefined') {
                result.icon = this.icon ?? 'standard:default';
            }
            return result;
        });
        // Add local state and dynamic class to search results
        this._focusedResultIndex = null;
        const self = this;
        this.searchResultsLocalState = this._searchResults?.map((result, i) => {
            return {
                result,
                state: {},
                get classes() {
                    let cls = 'slds-media slds-listbox__option slds-listbox__option_entity slds-listbox__option_has-meta';
                    if (result.subtitleFormatted) {
                        cls += ' slds-listbox__option_has-meta';
                    }
                    if (self._focusedResultIndex === i) {
                        cls += ' slds-has-focus';
                    }
                    return cls;
                }
            };
        });
    }

    @api
    getSelection() {
        return this._curSelection;
    }

    @api
    setDefaultResults(results) {
        this._defaultSearchResults = [...results];
        if (this._searchResults?.length === 0) {
            this.setSearchResults(this._defaultSearchResults);
        }
    }
    
    //lifecycle hooks
    connectedCallback(){
      if(this.wireDefaultOptions) this.recordsParam = this.getRecordsParam();
    }

    // WIRED PROPERTIES/FUNCTIONS
    @wire(getRecords, {records: '$recordsParam', fields: '$fields'})
    handleGetRecordsResponse(response){
      // console.log(`%c**getRecords response => ${JSON.stringify(response)}`, 'color:purple;font-wight:bold;');
      // const {data:{results}} = response;
      const results = response?.data?.results;
      const icon = this.icon;
      const defaultOptions = results?.map(({statusCode, result}) =>{
        // console.log(`%c**statusCode => ${statusCode}, result => ${JSON.stringify(result)}`, `color: ${statusCode === 200 ? 'green;' : 'red;'}`);
        if(statusCode === 200 && !!result){
          const {fields, id} = result;
          const option = {id, icon}
          this.fields?.map((field, index) => {
            const apiName = field?.split('.')?.at(1);
            const propName = index === 0 ? 'title' : 'subtitle';
            const value = fields[apiName]?.displayValue ?? fields[apiName]?.value;
            option[propName] = value;
          });
          return option;
        }
      }) ?? [];
      this.options = defaultOptions;
      this._curSelection = this.options?.filter(({id}) => this.selectedIds?.includes(id));
    }

    // INTERNAL FUNCTIONS
    getRecordsParam(recordIds = this.selectedIds){
      const fields =  this.fields;
      if(!recordIds || !fields) return;
      return recordIds?.reduce((records, recordId) =>{
        !!recordId ? records.push({recordIds: [recordId], fields}) : null;
        return records;
      }, []);
    }

    updateSearchTerm(newSearchTerm) {
        this._searchTerm = newSearchTerm;

        // Compare clean new search term with current one and abort if identical
        const newCleanSearchTerm = newSearchTerm.trim().replace(REGEX_SOSL_RESERVED, '?').toLowerCase();
        if (this._cleanSearchTerm === newCleanSearchTerm) {
            return;
        }

        // Save clean search term
        this._cleanSearchTerm = newCleanSearchTerm;

        // Ignore search terms that are too small after removing special characters
        if (newCleanSearchTerm.replace(/\?/g, '').length < this.minSearchTermLength) {
            this.setSearchResults(this._defaultSearchResults);
            return;
        }

        // Apply search throttling (prevents search if user is still typing)
        if (this._searchThrottlingTimeout) {
            clearTimeout(this._searchThrottlingTimeout);
        }
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._searchThrottlingTimeout = setTimeout(() => {
            // Send search event if search term is long enougth
            if (this._cleanSearchTerm.length >= this.minSearchTermLength) {
                // Display spinner until results are returned
                this.loading = true;

                const searchEvent = new CustomEvent('search', {
                    detail: {
                        searchTerm: this._cleanSearchTerm,
                        rawSearchTerm: newSearchTerm,
                        selectedIds: this.selectedIds
                    }
                });
                this.dispatchEvent(searchEvent);
            }
            this._searchThrottlingTimeout = null;
        }, SEARCH_DELAY);
    }

    processSelectionUpdate(isUserInteraction) {
        // Reset search
        this._cleanSearchTerm = '';
        this._searchTerm = '';
        this.setSearchResults([...this._defaultSearchResults]);
        // Indicate that component was interacted with
        this._isDirty = isUserInteraction;
        // Blur input after single select lookup selection
        if (!this.isMultiEntry && this.hasSelection) {
            this._hasFocus = false;
        }
        // If selection was changed by user, notify parent components
        if (isUserInteraction) {
            const selectedIds = this.selectedIds;
            this.dispatchEvent(new CustomEvent('selectionchange', { detail: selectedIds }));
        }
    }

    // EVENT HANDLING

    handleInput(event) {
        const {target: {value}} = event;
        return this.isSelectionAllowed ? this.updateSearchTerm(value) : undefined;
    }

    handleKeyDown(event) {
        const {keyCode, preventDefault} = event;
        if (this._focusedResultIndex === null) {
            this._focusedResultIndex = -1;
        }
        switch(keyCode){
            case KEY_ARROW_DOWN:
                // If we hit 'down', select the next item, or cycle over.
                this._focusedResultIndex++;
                if (this._focusedResultIndex >= this._searchResults?.length) {
                    this._focusedResultIndex = 0;
                }
                break;
            case KEY_ARROW_UP:
                // If we hit 'up', select the previous item, or cycle over.
                this._focusedResultIndex--;
                if (this._focusedResultIndex < 0) {
                    this._focusedResultIndex = this._searchResults.length - 1;
                }
                break;
            case KEY_ENTER:
                if(this._hasFocus && this._focusedResultIndex >= 0) {
                    // If the user presses enter, and the box is open, and we have used arrows,
                    // treat this just like a click on the listbox item
                    const selectedId = this._searchResults?.at(this._focusedResultIndex)?.id;
                    this.template.querySelector(`[data-recordid="${selectedId}"]`)?.click();
                }
                break;
            default:
                break;
        }
        preventDefault();
    }

    handleResultClick(event) {
        const recordId = event.currentTarget.dataset.recordid;

        // Save selection
        const selectedItem = this._searchResults.find(({id}) => id === recordId);
        if (!selectedItem) {
            return;
        }
        const curSelection = !!this._curSelection ? [...this._curSelection] : [];
        this._curSelection = [...curSelection, selectedItem];

        // Process selection update
        this.processSelectionUpdate(true);
    }

    handleComboboxMouseDown(event) {
        const mainButton = 0;
        if (event.button === mainButton) {
            this._cancelBlur = true;
        }
    }

    handleComboboxMouseUp() {
        this._cancelBlur = false;
        // Re-focus to text input for the next blur event
        this.template.querySelector('input')?.focus();
    }

    handleFocus() {
        // Prevent action if selection is not allowed
        if (!!this.isSelectionAllowed) {
            this._hasFocus = true;
            this._focusedResultIndex = null;
        }
    }

    handleBlur() {
        // Prevent action if selection is either not allowed or cancelled
        if (!this.isSelectionAllowed || this._cancelBlur) {
            return;
        }
        this._hasFocus = false;
    }

    handleRemoveSelectedItem(event) {
        if (this.disabled) {
            return;
        }
        const recordId = event.currentTarget.name;
        this._curSelection = this._curSelection?.filter(({id}) => id !== recordId);
        // Process selection update
        this.processSelectionUpdate(true);
    }

    handleClearSelection() {
        this._curSelection = undefined;
        this._hasFocus = false;
        // Process selection update
        this.processSelectionUpdate(true);
    }
    
    async handleNewRecordClick(event){
        const objectApiName = event?.currentTarget?.dataset?.sobject;
        const selection = this.newRecordOptions?.find(({value}) => value === objectApiName);
        const preNavigateCallback = selection?.preNavigateCallback ?? () => Promise.resolve();
        if(!!selection) {
            await preNavigateCallback(selection);
            const actionName = 'new';
            const type = 'standard__objectPage';
            const attributes = {
                objectApiName,
                actionName
            }
            const defaultFieldValues = selection?.defaults;
            const state = { defaultFieldValues }
            this[NavigationMixin.Navigate]({ attributes, state, type });
        }
    }

    // STYLE EXPRESSIONS

    get hasResults() {
        return this._searchResults?.length > 0;
    }

    get hasSelection(){
      return this._curSelection?.length > 0;
    }

    get selectedIds(){
      return this._curSelection?.map(value => {
        switch(typeof(value)){
          case 'string':
            return value;
          default:
            return value?.id;
        }
      });
    }
    
    get isSelectionAllowed() {
        return this.isMultiEntry ? true : !this.hasSelection;
    }

    get getFormElementClass() {
        return this.variant === VARIANT_LABEL_INLINE
            ? 'slds-form-element slds-form-element_horizontal'
            : 'slds-form-element';
    }

    get getLabelClass() {
        return this.variant === VARIANT_LABEL_HIDDEN
            ? 'slds-form-element__label slds-assistive-text'
            : 'slds-form-element__label';
    }

    get getContainerClass() {
        let css = 'slds-combobox_container';
        if (this.errors.length > 0) {
            css += ' has-custom-error';
        }
        return css;
    }

    get getDropdownClass() {
        let css = 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click';
        const isSearchTermValid = this._cleanSearchTerm && this._cleanSearchTerm.length >= this.minSearchTermLength;
        if (
            this._hasFocus &&
            this.isSelectionAllowed &&
            (isSearchTermValid || this.hasResults || this.newRecordOptions?.length)
        ) {
            css += ' slds-is-open';
        }
        return css;
    }

    get getInputClass() {
        let css = 'slds-input slds-combobox__input has-custom-height ';
        if (this._hasFocus && this.hasResults) {
            css += 'slds-has-focus ';
        }
        if (this.errors?.length > 0 || (this._isDirty && this.required && !this.hasSelection)) {
            css += 'has-custom-error ';
        }
        if (!this.isMultiEntry) {
            css += 'slds-combobox__input-value ' + (this.hasSelection ? 'has-custom-border' : '');
        }
        return css;
    }

    get getComboboxClass() {
        let css = 'slds-combobox__form-element slds-input-has-icon ';
        if (this.isMultiEntry) {
            css += 'slds-input-has-icon_right';
        } else {
            css += this.hasSelection ? 'slds-input-has-icon_left-right' : 'slds-input-has-icon_right';
        }
        return css;
    }

    get getSearchIconClass() {
        let css = 'slds-input__icon slds-input__icon_right ';
        if (!this.isMultiEntry) {
            css += this.hasSelection ? 'slds-hide' : '';
        }
        return css;
    }

    get getClearSelectionButtonClass() {
        return (
            'slds-button slds-button_icon slds-input__icon slds-input__icon_right ' +
            (this.hasSelection ? '' : 'slds-hide')
        );
    }

    get getSelectIconName() {
        return this.hasSelection ? this._curSelection?.at(0)?.icon : 'standard:default';
    }

    get getSelectIconClass() {
        let cls = 'slds-combobox__input-entity-icon';
        !this.hasSelection ? cls += ' slds-hide';
        return cls;
    }

    get getInputValue() {
        return this.isMultiEntry ? this._searchTerm : this._curSelection?.at(0)?.title ?? this._searchTerm;
    }

    get getInputTitle() {
        return !this.isMultiEntry ? this._curSelection?.at(0)?.title ?? '' : '';
    }

    get getListboxClass() {
        let cls = 'slds-dropdown';
        this.scrollAfterNItems ? cls += ' slds-dropdown_length-with-icon-${this.scollAfterNItems}` : null;
        cls += 'slds-dropdwon_fluid';
        return cls;
    }

    get isInputReadonly() {
        return this.isMultiEntry ? false : this.hasSelection;
    }

}
