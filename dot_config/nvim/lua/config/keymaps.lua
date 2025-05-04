-- Mappings
local map = vim.keymap.set

-- leader
vim.g.mapleader = " "

-- Open Lazy, the plugin manager
map("n", "<leader>l", ":Lazy<CR>", { silent = true })

-- Comments
map({ "n", "v" }, "<leader>c", "gc", { remap = true, silent = true })
map("n", "<leader>c<leader>c", "gcgc", { remap = true, silent = true })
map("n", "<leader>cap", "gcip", { remap = true, silent = true })

-- Disable mapping, it will be enabled later if a formatter is available
map("n", "<leader>f", "", { silent = true })

-- Quick save
map("n", "<leader>w", ":w<CR>", { silent = true })

-- Easier yank/paste to clipboard
map({ "n", "v" }, "<leader>d", '"+d', { remap = true, silent = true, desc = "Delete to clipboard" })
map({ "n", "v" }, "<leader>y", '"+y', { remap = true, silent = true, desc = "Yank to clipboard" })
map("n", "<leader>p", '"+p', { remap = true, silent = true, desc = "Paste from clipboard" })
map("n", "<leader>P", '"+P', { remap = true, silent = true, desc = "Paste from clipboard before cursor" })

-- Yank-comment
map({ "n", "v" }, "yc", "yygccp", { remap = true, silent = true, desc = "Duplicate and comment line" })

-- Move between windows
map("n", "<C-k>", "<C-w>k")
map("n", "<C-j>", "<C-w>j")
map("n", "<C-h>", "<C-w>h")
map("n", "<C-l>", "<C-w>l")

-- Quickly switch buffer
map("n", "<BS>", ":b#<CR>", { silent = true })

-- Exit
map("n", "<leader>q", ":qa<CR>", { silent = true })

-- Super <ESC>
map({ "i", "s", "n" }, "<ESC>", function()
  -- Clear search highlight
  vim.cmd("noh")

  -- Close active floating windows
  local current_win = vim.api.nvim_get_current_win()
  local win_config = vim.api.nvim_win_get_config(current_win)
  if win_config and win_config.relative ~= "" then
    -- Schedule close to be invoked by the main loop, to avoid textlock
    vim.schedule(function()
      vim.api.nvim_win_close(current_win, false)
    end)
  end

  -- Finally, return <ESC>
  return "<ESC>"
end, { desc = "Clear hlsearch, close floating windows and send Escape", expr = true })
