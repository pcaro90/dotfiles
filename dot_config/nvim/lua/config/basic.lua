-- Basic settings
vim.o.expandtab = true -- Convert tabs to spaces
vim.o.tabstop = 4 -- How many spaces a tab represents
vim.o.softtabstop = 4 -- How many spaces a tab represents, while editing
vim.o.shiftwidth = 0 -- How many spaces to indent (0 = tabstop)
vim.o.autoindent = true -- Automatically indent
vim.o.number = true -- Show line number
vim.o.showmatch = true -- Show matching braces
vim.o.ignorecase = true -- Do case insensitive search...
vim.o.smartcase = true -- ...but change to case sensitive if uppercase is searched
vim.o.autoread = true -- Auto recharge changed files
vim.o.scrolloff = 8 -- Scroll distance
vim.o.signcolumn = "auto:2-4" -- Show sign column, min 2, max 4

-- Show whitespace.
vim.opt.list = true
vim.opt.listchars = { space = "⋅", trail = "⋅", tab = " ↦" }

-- vim.cmd("filetype on")
-- vim.opt.termguicolors = true

-- Define how many ms are considered "idle", to trigger CursorHold (hl hovered word) and save swap
vim.o.updatetime = 200

-- Define how many ms to wait to consider a mapped sequence is completed
vim.o.timeoutlen = 500
