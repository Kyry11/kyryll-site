<?php

if(!isset($_POST['word']))
{
	//This page should not be accessed directly. Need to submit the form.
	echo "You can't access this page directly! Kyryll says hi:)";
	exit;
}

//header('Content-type: text/xml'); // didnt work for some reason

$word = $_POST['word'];
$ref = $_POST['ref'];
$key = $_POST['key'];

$uri = "http://www.dictionaryapi.com/api/v1/references/" . urlencode($ref) . "/xml/" . urlencode($word) . "?key=" . urlencode($key);
$def = file_get_contents($uri);

echo $def;
 
?> 