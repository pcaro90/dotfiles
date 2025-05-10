local methods = vim.lsp.protocol.Methods

vim.g.lsp_servers = {
  "lua_ls",
  "basedpyright",
  "ruff",
  "rust_analyzer",
}

-- This funcion will be called when a LSP client is attached
local on_attach = function(client, bufnr)
  local map = vim.keymap.set

  -- Common LSP keymaps
  -- map('n', '<leader>rn', vim.lsp.buf.rename, { buffer = bufnr, desc = 'LSP: Rename symbol' })
  -- map("n", "<leader>q", vim.diagnostic.setloclist, { buffer = bufnr, desc = "Diag: Add to location list" })

  map({ "i" }, "<C-S-k>", vim.lsp.buf.signature_help, { buffer = bufnr, desc = "LSP: Show signature help" })
  map({ "n" }, "<C-S-k>", vim.lsp.buf.hover, { buffer = bufnr, desc = "LSP: Show hover help" })

  -- Diagnostics
  -- NOTE: Method "textDocument_publishDiagnostics" is not recognized by lua_ls, for some reason
  -- if client:supports_method(methods.textDocument_diagnostic) then
  map("n", "<leader>dd", function()
    vim.diagnostic.open_float({
      source = true,
    })
  end, { buffer = bufnr, desc = "Diag: Open floating diagnostic for current line" })
  map("n", "<leader>fd", function()
    require("fzf-lua").lsp_document_diagnostics({ diag_source = true })
  end, { buffer = bufnr, desc = "Diag: Open all diagnostics for current file" })
  map("n", "<leader>fD", function()
    require("fzf-lua").lsp_workspace_diagnostics({ diag_source = true })
  end, { buffer = bufnr, desc = "Diag: Open all diagnostics for current workspace" })

  -- Definitions: Peek and go to (with fzf-lua)
  if client:supports_method(methods.textDocument_definition) then
    map("n", "gd", function()
      require("fzf-lua").lsp_definitions({ jump1 = false })
    end, { desc = "LSP: Peek definition in fzf" })
    map("n", "gD", function()
      require("fzf-lua").lsp_definitions({ jump1 = true })
    end, { desc = "LSP: Go to definition with fzf" })
  end

  -- References
  if client:supports_method(methods.textDocument_references) then
    map("n", "<leader>fr", function()
      require("fzf-lua").lsp_references()
    end, { desc = "LSP: Open references in fzf" })
  end

  -- Symbols
  if client:supports_method(methods.textDocument_documentSymbol) then
    map("n", "<leader>fs", function()
      require("fzf-lua").lsp_document_symbols()
    end, { desc = "LSP: Open document symbols in fzf" })
    map("n", "<leader>fS", function()
      require("fzf-lua").lsp_live_workspace_symbols({ no_header_i = true })
    end, { desc = "LSP: Open workspace symbols in fzf" })
  end

  -- -- Typedefs
  -- if client:supports_method(methods.textDocument_typeDefinition) then
  --  map("n", "<leader>ftd", function()
  --    require("fzf-lua").lsp_typedefs()
  --  end, { desc = "LSP: Open typedefs in fzf" })
  -- end

  -- Code actions
  if client:supports_method(methods.textDocument_codeAction) then
    map({ "n", "v" }, "<C-.>", vim.lsp.buf.code_action, { buffer = bufnr, desc = "LSP: Code actions for current line" })
    map("n", "<leader>fca", function()
      require("fzf-lua").lsp_code_actions()
    end, { desc = "LSP: Code actions for current document" })
  end

  -- Highlight when the cursor is idle
  if client:supports_method(methods.textDocument_documentHighlight) then
    local under_cursor_highlights_group = vim.api.nvim_create_augroup("cursor_highlights", { clear = false })
    vim.api.nvim_create_autocmd({ "CursorHold", "InsertLeave" }, {
      group = under_cursor_highlights_group,
      desc = "Highlight references under the cursor",
      buffer = bufnr,
      callback = vim.lsp.buf.document_highlight,
    })
    vim.api.nvim_create_autocmd({ "CursorMoved", "InsertEnter", "BufLeave" }, {
      group = under_cursor_highlights_group,
      desc = "Clear highlight references",
      buffer = bufnr,
      callback = vim.lsp.buf.clear_references,
    })
  end

  -- Inlay hints
  if client:supports_method(methods.textDocument_inlayHint) then
    vim.g.inlay_hints = false
    map({ "n", "i" }, "<C-5>", function()
      vim.g.inlay_hints = not vim.g.inlay_hints

      vim.notify(
        string.format("%s inlay hints...", vim.g.inlay_hints and "Enabling" or "Disabling"),
        vim.log.levels.INFO
      )

      local mode = vim.api.nvim_get_mode().mode
      vim.lsp.inlay_hint.enable(vim.g.inlay_hints and (mode == "n" or mode == "v"))
    end, { desc = "Toggle inlay hints" })
  end
end

-- Create autocmd to call on_attach
vim.api.nvim_create_autocmd("LspAttach", {
  desc = "Configure LSP keymaps and options",
  callback = function(args)
    local lsp_client = vim.lsp.get_client_by_id(args.data.client_id)
    on_attach(lsp_client, args.buf)
  end,
})

-- Enable every LSP in vim.g.lsp_servers
-- NOTE: Mason and mason-lspconfig need to be loaded before enabling servers
for _, server in ipairs(vim.g.lsp_servers) do
  vim.lsp.enable(server)
end

-- Diagnostics
vim.diagnostic.config({
  virtual_text = true, -- Show inline text (at the end of the line)
  -- signs = true, -- Show gutter icons
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "",
      [vim.diagnostic.severity.WARN] = "",
      [vim.diagnostic.severity.HINT] = "",
      [vim.diagnostic.severity.INFO] = "",
    },
  },
  underline = true, -- Underline text
  update_in_insert = false, -- Do not update while editing
  severity_sort = true, -- Sort by severity
})

return {}
