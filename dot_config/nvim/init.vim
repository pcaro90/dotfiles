" ---------------------------------------------------
" Copyright (c) 2020 Pablo Caro. All Rights Reserved.
" Pablo Caro <me@pcaro.es> - http://pcaro.es/
" vimrc
" ---------------------------------------------------
"
"   Mappings summary {{{1
"      Leader
"          <leader> v : Edit vimrc
"          <leader> vv : Close and source init.vim
"          <leader> w : Write file (:w)
"          <leader> h : Fold
"          <leader> l : Unfold
"          <leader> fa : Fold all
"          <leader> uf : Unfold all
"          <leader> c : gc (commentary.vim)
"          <leader> cc : gcc (commentary.vim)
"
"      Ctrl
"          <C-j> : Next fold group
"          <C-k> : Previous fold group
"          <C-h> : Focus previous window
"          <C-l> : Focus next window
"          <C-b> : Delete buffer
"
"       Insert mode
"          <C-Space> : Expand snippet
"          <TAB> : Autocomplete
"
"      Function keys
"          <F3> : Show hidden characters and toggle conceal
"          <F4> : Stop highlighting current search
"          <F5> : Make/python

"          <F8> : Toggle undotree
"          <F9> : Toggle NERDtree
"          <F10> : Toggle Tagbar
"
"      Others
"          w!! (command mode) : Write file as super user
"

" Preferences {{{1
    " Not vi compatible
    set nocompatible

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
    set softtabstop=4
    set shiftwidth=4

    " Start with every fold opened
    set foldlevelstart=1

    " Fold only with 2 levels of nesting
    set foldnestmax=2

    " Invisible characters
    set listchars=tab:>\ ,trail:~,eol:$

    " Show before wrapped lines
    set showbreak=>>>

    " Show line numbers, as well as row and column
    set number
    set ruler

    " Highlight searches (not at the beginning), and incremental searching
    set hlsearch
    nohlsearch
    set incsearch

    " Show matching brace
    set showmatch

    " Smart casing when searching (ignore case unless an uppercase is found)
    set ignorecase
    set smartcase

    " " A $ sign delimits what is being changed
    " set cpoptions+=$

    " Modified buffers can be put in background
    set hidden

    " Auto recharge changed files
    set autoread

    " Don't use beep nor visual bell
    set visualbell t_vb=

    " Status line in the last window
    set laststatus=2

    " The width of the text is 88 characters maximum (because of Black)
    set textwidth=88

    " Mark the column next to textwidth
    set colorcolumn=+1

    " Formatting options
    set formatoptions=
    set formatoptions+=c  " Auto-wrap comments
    set formatoptions+=r  " Insert comment leader after <CR> in insert mode
    set formatoptions+=q  " Allow formatting of comments with "gq"
    set formatoptions+=l  " Long lines are not broken in insert mode
    set formatoptions+=j  " Remove comment leader when joining, if applies

    " Set autocompletion behaviour similar to bash
    set wildmode=longest,full
    set wildmenu

    " Backspace over autoindent, eol and start of indent.
    " same as ":set backspace=indent,eol,start"
    set backspace=2

    " Reduced timeout for mappings and key codes
    set timeoutlen=500

    " Specify a Python 3 provider BEFORE syntax
    let g:python3_host_prog = "/usr/bin/python3"

    " Syntax highlighting on
    syntax on

    " Default to latex instead of plain tex
    let g:tex_flavor = "latex"

    " Jump to the last position when reopening a file
    if has("autocmd")
        au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g'\"" | endif
    endif

    " " Use persistent undo
    " if has("persistent_undo")
    "     set undodir=.stdpath('config')."undo"
    "     set undofile
    " endif

" Plug configuration {{{1

    call plug#begin()

    " fugitive.vim - A git wrapper so awesome, it should be illegal
    Plug 'tpope/vim-fugitive'

    " surround.vim - quoting/parenthesizing made simple
    Plug 'tpope/vim-surround'

    " unimpaired.vim - Pairs of handy bracket mappings
    Plug 'tpope/vim-unimpaired'

    " commentary.vim - Comment stuff
    Plug 'tpope/vim-commentary'

    " repeat.vim - Enable repeating supported plugin maps with "."
    Plug 'tpope/vim-repeat'

    " indentline - Display indention levels with vertical lines (conceal)
    Plug 'yggdroot/indentline'

    " vim-polyglot - A collection of language packs
    Plug 'sheerun/vim-polyglot'

    " Highlight all trailing whitespace characters
    Plug 'ntpeters/vim-better-whitespace'

    " NERDtree - A tree explorer plugin
    Plug 'scrooloose/nerdtree'

    " undotree.vim - Visualizes undo history
    Plug 'mbbill/undotree'

    " Auto Pairs - Insert or delete brackets, parens, quotes in pair
    Plug 'jiangmiao/auto-pairs'

    " Tagbar - Class outline viewer
    Plug 'majutsushi/tagbar'

    " EasyMotion - Vim motions on speed
    Plug 'easymotion/vim-easymotion'

    " LaTeX-BoX - Lightweight Toolbox for LaTeX
    Plug 'LaTeX-Box-Team/LaTeX-Box'

    " Jellybeans color scheme
    Plug 'nanotech/jellybeans.vim'

    " Vim-Go - Go development plugin for Vim
    Plug 'fatih/vim-go'

    " Wakatime - Programming metrics
    Plug 'wakatime/vim-wakatime'

    call plug#end()

" Color configuration {{{1

    " Confused gnome-terminal is confused
    if $COLORTERM == 'gnome-terminal'
        set t_Co=256
    endif

    set background=dark

    " Jellybeans
    let g:jellybeans_overrides = {
    \    'background': { 'ctermbg': 'none', '256ctermbg': 'none' },
    \}
    if has('termguicolors') && &termguicolors
        let g:jellybeans_overrides['background']['guibg'] = 'none'
    endif

    colorscheme jellybeans

" Status line {{{1
    set statusline=
    set statusline+=%1*\ [%2*%2n%1*]  " Buffer number
    set statusline+=%<  " Truncate the path if needed
    set statusline+=%3*\ %f  " File name
    set statusline+=%4*%5r  " ReadOnly flag
    set statusline+=%5*\ %y  " File type
    set statusline+=%6*\ %m  " Modified flag

    set statusline+=%=  " Separation

    set statusline+=%1*\ [col\ %3*%v%1*]  " Virtual column number
    set statusline+=%1*\ [row\ %2*%l%1*/%2*%L%1*\ %p%%]  " Current/total line
    set statusline+=%1*\ [byte\ %5*%o%1*]  " Byte number in file

    hi User1 ctermfg=White guifg=#eeeeee ctermbg=235 guibg=#262626
    hi User2 ctermfg=DarkRed guifg=#d75757 ctermbg=235 guibg=#262626
    hi User3 ctermfg=DarkGreen guifg=#87af5f ctermbg=235 guibg=#262626
    hi User4 ctermfg=DarkBlue guifg=#0087ff ctermbg=235 guibg=#262626
    hi User5 ctermfg=Yellow guifg=#ffd75f ctermbg=235 guibg=#262626
    hi User6 ctermfg=DarkMagenta guifg=#af5faf ctermbg=235 guibg=#262626
    hi User7 ctermfg=DarkRed guifg=#d75757 ctermbg=235 guibg=#262626

" Mappings {{{1
    " Mapping leader
    let mapleader=" "

    " Edit vimrc file
    nnoremap <leader>v :edit $MYVIMRC<CR>

    " Source vimrc file
    nnoremap <leader>vv :bdelete init.vim<CR>:source $MYVIMRC<CR>

    " Fast save
    nnoremap <leader>w :write<CR>

    " Fold and unfold code
    nnoremap <leader>l zo
    nnoremap <leader>h zc
    nnoremap <leader>fa zM
    nnoremap <leader>uf zR

    " Move between folds
    nnoremap <C-j> zj
    nnoremap <C-k> zk

    " Fast moving between windows
    nnoremap <C-h> <C-w>W
    nnoremap <C-l> <C-w>w

    " Fast buffer delete
    nnoremap <C-b> :bdelete<CR>

    " List invisible characters
    nnoremap <silent> <F3> :set list!<CR>:let &conceallevel=2-&conceallevel<CR>

    " Stop search highlighting
    nnoremap <silent> <F4> :nohlsearch<CR>

    " Call Make (it may change depending on the file type)
    nnoremap <F5> :make<CR>

    " Allow saving of files as super user without start vim using sudo
    " http://stackoverflow.com/questions/2600783/how-does-the-vim-write-with-sudo-trick-work
    cnoremap w!! w !sudo tee > /dev/null %

" Plugins options and mappings {{{1
"
    " " DeleteTrailingWhitespace
    "     let g:DeleteTrailingWhitespace = 0
    "     " let g:DeleteTrailingWhitespace_Action = 'ask'
    "     nnoremap <Leader>d :<C-u>%DeleteTrailingWhitespace<CR>

    " commentary.vim
    " NOTE: These mappings HAVE to allow recursive mapping
    nmap <leader>c gc
    vmap <leader>c gc
    nmap <leader>cc gcc
    au FileType c,cpp set commentstring=//\ %s

    " TeX-PDF
    let g:tex_pdf_map_keys = 0

    " NERDtree
    nnoremap <F9> :NERDTreeToggle<CR>

    let NERDTreeMapOpenSplit='s'
    let NERDTreeMapOpenVSplit='v'
    let NERDTreeQuitOnOpen=1

    " Tagbar
    nnoremap <F10> :TagbarOpenAutoClose<CR>

    " undotree
    nnoremap <F8> :UndotreeToggle<CR>:UndotreeFocus<CR>

    " EasyMotion
    let g:EasyMotion_keys = 'arsdheiqwfpgjluy;zxcvbkmtno'

" Extra functions {{{1

    " " If buffer modified, update any 'Last modified: ' in the first 20 lines.
    " " http://vim.wikia.com/wiki/Insert_current_date_or_time
    " function! LastModified()
    "     if &modified
    "         let save_cursor = getpos(".")
    "         let n = min([20, line("$")])
    "         keepjumps exe '1,' . n . 's#^\(.\{,10}Last modified: \).*#\1' .
    "                     \ strftime('%a %b %d, %Y  %I:%M%p') . '#e'
    "         call histdel('search', -1)
    "         call setpos('.', save_cursor)
    "     endif
    " endfunction


" Autocommands {{{1
    if has("autocmd")

        " " Update last modified date
        " autocmd BufWritePre * call LastModified()

        " Fold vim file using markers
        autocmd FileType vim setlocal foldmethod=marker

        " Use tabs with makefiles
        autocmd FileType make setlocal tabstop=8 softtabstop=8 shiftwidth=8 noexpandtab

        " Formatting options:
        "   t - Auto-wrap text
        "   l - Long lines are not broken in insert mode
        autocmd FileType markdown,tex setlocal formatoptions+=t formatoptions-=l

        " Python
        autocmd FileType python nnoremap <buffer> <F5> :!python %<CR>
        " autocmd BufWritePre *.py execute ':Black'

        " Go execute
        autocmd FileType go nnoremap <buffer> <F5> :GoRun<CR>

        " Nim
        autocmd Filetype nim setlocal expandtab tabstop=2 shiftwidth=2 softtabstop=2

        " " OUT
        " " Latex build
        " autocmd FileType tex nnoremap <buffer> <silent> <F5> :BuildTexPdf<CR>

        " Javascript syntax
        autocmd Filetype javascript setlocal tabstop=2 softtabstop=2 shiftwidth=2

        " LaTeX spanish chars
        augroup LaTeX
            autocmd!
            autocmd FileType tex imap <buffer> á \'a
            autocmd FileType tex imap <buffer> Á \'A
            autocmd FileType tex imap <buffer> é \'e
            autocmd FileType tex imap <buffer> É \'E
            autocmd FileType tex imap <buffer> í \'i
            autocmd FileType tex imap <buffer> Í \'I
            autocmd FileType tex imap <buffer> ó \'o
            autocmd FileType tex imap <buffer> Ó \'O
            autocmd FileType tex imap <buffer> ú \'u
            autocmd FileType tex imap <buffer> Ú \'U
            autocmd FileType tex imap <buffer> ñ \~n
            autocmd FileType tex imap <buffer> Ñ \~N
        augroup end

        " License file type
        autocmd BufEnter LICENSE set filetype=license

        " Gitignore file type
        augroup Gitignore
            autocmd!
            autocmd BufEnter .gitignore set filetype=gitignore
            autocmd FileType gitignore set commentstring=#%s
        augroup end

    endif
