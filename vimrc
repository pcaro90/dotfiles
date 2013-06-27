"
" ------------------------------------
" Pablo Caro Martin - http://pcaro.es/
" .vimrc file
" ------------------------------------
"

" History length
    set history=1000

" Show typing command
    set showcmd

" Keep a distance of 8 lines when scrolling
    set scrolloff=8

" Autoindent the code
    set autoindent

" Defining tab behavior: spaces instead of tab, 4 spaces width
    set expandtab
    set tabstop=4
    set shiftwidth=4

" Show line numbers, as well as row and column
    set number
    set ruler

" Highlight searches, and incremental searching
    set hlsearch
    set incsearch

" Show matching brace
    set showmatch

" Smart casing when searching (ignore case unless an uppercase is found)
    set ignorecase
    set smartcase

" A $ sign delimits what is being changed
    set cpoptions+=$

" Modified buffers can be put in background
    set hidden

" Auto recharge changed files
    set autoread

" Visual bell instead of beep
    set visualbell

" The width of the text is 80 characters maximum
    set textwidth=80

" Backspace over autoindent, eol and start of indent.
" same as ":set backspace=indent,eol,start"
    set backspace=2

" Reduced timeout for mappings and key codes
    set timeoutlen=500

" Syntax highlighting on
    syntax on

" Vundle configuration
" http://www.erikzaadi.com/2012/03/19/auto-installing-vundle-from-your-vimrc/
    filetype off

    let vundle_active=1
    let vundle_readme=expand('~/.vim/bundle/vundle/README.md')
    if !filereadable(vundle_readme)
        echo "Installing Vundle."
        echo ""
        silent !git clone https://github.com/gmarik/vundle ~/.vim/bundle/vundle
        let vundle_active=0
    endif

    set rtp+=~/.vim/bundle/vundle/
    call vundle#rc()

    " let Vundle manage Vundle
    Bundle 'gmarik/vundle'

    " repeat.vim - Enable repeating supported plugin maps with "."
    Bundle 'tpope/vim-repeat'

    " unimpaired.vim - Pairs of handy bracket mappings
    Bundle 'tpope/vim-unimpaired'

    " commentary.vim - Comment stuff
    Bundle 'tpope/vim-commentary'

    " surround.vim - quoting/parenthesizing made simple
    Bundle 'tpope/vim-surround'

    " DeleteTrailingWhitespace - Delete unwanted whitespace at the end of lines
    Bundle 'DeleteTrailingWhitespace'

    " Jellybeans color scheme
    Bundle 'nanotech/jellybeans.vim'

    " molokai color scheme
    Bundle 'tomasr/molokai'

    " original repos on github
    " Bundle 'tpope/vim-fugitive'
    " Bundle 'Lokaltog/vim-easymotion'
    " Bundle 'rstacruz/sparkup', {'rtp': 'vim/'}
    " Bundle 'tpope/vim-rails.git'
    " vim-scripts repos
    " Bundle 'L9'
    " Bundle 'FuzzyFinder'
    " Filetipe stuff

    if vundle_active == 0
        echo "Installing Bundles, please ignore key map error messages."
        echo ""
        :BundleInstall
    endif

    filetype plugin indent on

" Color configuration
    set background=dark
    let g:molokai_original=1

    if &t_Co <= 16
        let g:jellybeans_use_lowcolor_black=0
    endif


    "colorscheme molokai
    colorscheme jellybeans

    " Trailing space
        highlight trailing_spaces ctermbg=red guibg=red
        match trailing_spaces /\s\+$/

" Mappings
    " Mapping leader
    let mapleader="" " Default: \

    " Allow saving of files as super user without start vim using sudo
    " http://stackoverflow.com/questions/2600783/how-does-the-vim-write-with-sudo-trick-work
        cnoremap w!! w !sudo tee > /dev/null %

    " Faster return to Normal Mode
        inoremap nn <Esc>

    " Inverted "go to mark" and "go to mark line"
        nnoremap ' `
        nnoremap ` '

" Plugins options and mappings
    " DeleteTrailingWhitespace
        nnoremap <Leader>ds :<C-u>%DeleteTrailingWhitespace<CR>
        vnoremap <Leader>ds :DeleteTrailingWhitespace<CR>
