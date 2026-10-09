$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$repoFiles = @{
    'e5' = @{repo='intfloat/multilingual-e5-small'; files=@('config.json','modules.json','sentence_bert_config.json','tokenizer_config.json','special_tokens_map.json','tokenizer.json','sentencepiece.bpe.model','1_Pooling/config.json')}
    'reranker' = @{repo='cross-encoder/mmarco-mMiniLMv2-L12-H384-v1'; files=@('config.json','tokenizer_config.json','special_tokens_map.json','tokenizer.json','sentencepiece.bpe.model','vocab.txt')}
}
foreach ($entry in $repoFiles.GetEnumerator()) {
    foreach ($file in $entry.Value.files) {
        $destination = Join-Path (Join-Path '.cache/manual' $entry.Key) $file
        New-Item -ItemType Directory -Force (Split-Path -Parent $destination) | Out-Null
        & curl.exe -s -f -L --connect-timeout 10 --max-time 60 --retry 1 -o $destination "https://hf-mirror.com/$($entry.Value.repo)/resolve/main/$file"
        # Some tokenizer formats are optional depending on model architecture.
        if ($LASTEXITCODE -eq 0) { Write-Output "$($entry.Key)/$file downloaded" }
    }
}
