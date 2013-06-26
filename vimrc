"
" ------------------------------------
" Pablo Caro Martin - http://pcaro.es/
" .vimrc file
" ------------------------------------
"

" History length
set history=200

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
set numberwidth=4
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

" The width of the text is 80 characters maximum
set textwidth=80

" Backspace over autoindent, eol and start of indent.
" same as ":set backspace=indent,eol,start"
set backspace=2

" Mappings
" Allow saving of files as super user without start vim using sudo
" http://stackoverflow.com/questions/2600783/how-does-the-vim-write-with-sudo-trick-work
cnoremap w!! w !sudo tee > /dev/null %

" Quick buffer browsing (from Tim Pope's unimpaired.vim)
nnoremap <silent> [b :bprevious<CR>
nnoremap <silent> ]b :bnext<CR>
nnoremap <silent> [B :bfirst<CR>
nnoremap <silent> ]B :blast<CR>


" Syntax highlighting on
syntax on

" Filetipe stuff
filetype on
filetype plugin on
filetype indent on
 
" Color configuration

set background=dark
let g:molokai_original = 1

if &t_Co <= 16
    let g:jellybeans_use_lowcolor_black=0
endif

"colorscheme molokai
colorscheme jellybeans
