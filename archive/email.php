<?php
if(!isset($_POST['sendername'])) //$_POST['submit']))
{
	//This page should not be accessed directly. Need to submit the form.
	echo "You can't access this page directly!";
	exit;
}

//header('Content-type: text/xml'); // didnt work for some reason

$name = $_POST['sendername'];
$visitor_email = $_POST['email'];
$message = $_POST['comments'];
$phone = $_POST['phone'];
$info = $_POST['info'];
$vid = $_POST['vid'];
$nov = $_POST['nov'];
$fv = $_POST['fv'];
$is_mobile = $_POST['ismobile'];

//Validate first

if(empty($info))
{
	if(empty($name)) 
	{
	    echo "<xml>";
	    echo "<status>";
	    echo "2";
	    echo "</status>";
	    echo "<field>";
	    echo "sendername";
	    echo "</field>";
	    echo "<message>";
	    echo "Please fill in your name";
	    echo "</message>";
	    echo "</xml>";
	    exit;
	}
	
	if(empty($visitor_email)) 
	{
	    echo "<xml>";
	    echo "<status>";
	    echo "2";
	    echo "</status>";
	    echo "<field>";
	    echo "email";
	    echo "</field>";
	    echo "<message>";
	    echo "Please fill in your email";
	    echo "</message>";
	    echo "</xml>";
	    exit;
	}
	
	if(IsInjected($visitor_email))
	{
	    echo "<xml>";
	    echo "<status>";
	    echo "2";
	    echo "</status>";
	    echo "<field>";
	    echo "email";
	    echo "</field>";
	    echo "<message>";
	    echo "No injection attacks, sorry";
	    echo "</message>";
	    echo "</xml>";
	    exit;
	}
}

$ip_client_ip = "";
$ip_x_forwarded_for = "";
$ip_x_forwarded = "";
$ip_forwarded_for = "";
$ip_forwarded = "";
$ip_remote_addr = "";

if ($_SERVER['HTTP_CLIENT_IP']) {
    $ip_client_ip = $_SERVER['HTTP_CLIENT_IP'];
}
if($_SERVER['HTTP_X_FORWARDED_FOR']) {
    $ip_x_forwarded_for = $_SERVER['HTTP_X_FORWARDED_FOR'];
}
if($_SERVER['HTTP_X_FORWARDED']) {
    $ip_x_forwarded = $_SERVER['HTTP_X_FORWARDED'];
}
if($_SERVER['HTTP_FORWARDED_FOR']) {
    $ip_forwarded_for = $_SERVER['HTTP_FORWARDED_FOR'];
}
if($_SERVER['HTTP_FORWARDED']) {
    $ip_forwarded = $_SERVER['HTTP_FORWARDED'];
}
if($_SERVER['REMOTE_ADDR']) {
    $ip_remote_addr = $_SERVER['REMOTE_ADDR'];
}

$email_subject = "";
$message_type = "";

if(!empty($name)) {
	$email_subject = "Message from - $name";
	$message_type = "message";
} else {
	$email_subject = "Logged event from - $vid";
	$message_type = "logged event";
}

$email_from = 'Kyryll\'s Site<mailer@kyryll.com>';
$email_body = "You have received a new $message_type.\n\nUser: $name\nPhone: $phone\nEmail: $visitor_email\nVisitor ID: $vid\nNumber of Visits: $nov\nFirst Visit: $fv\nIs Mobile: $is_mobile\nClient IP: $ip_client_ip XFF: $ip_x_forwarded_for XF: $ip_x_forwarded IPFF: $ip_forwarded_for IPF: $ip_forwarded IPRA: $ip_remote_addr";

if(!empty($info)) {
	$email_body .= "\n\nEvent:\n\n$info";
}

if(!empty($message)) {
	$email_body .= "\n\nMessage:\n\n$message";
}

$to = "Kyryll<website@kyryll.com>";
$headers = "From: $email_from \r\n";
$headers .= "Reply-To: $name<$visitor_email> \r\n";

//Send the email
mail($to,$email_subject,$email_body,$headers);

//redirect to thank-you page.
//header('Location: thank-you.html');

echo "<xml>";
echo "<status>";
echo "1";
echo "</status>";
echo "<field>";
echo "</field>";
echo "<message>";
echo "Message has been sent, I will get back to you sooon";
echo "</message>";
echo "</xml>";

// Function to validate against any email injection attempts
function IsInjected($str)
{
  $injections = array('(\n+)',
              '(\r+)',
              '(\t+)',
              '(%0A+)',
              '(%0D+)',
              '(%08+)',
              '(%09+)'
              );
  $inject = join('|', $injections);
  $inject = "/$inject/i";
  if(preg_match($inject,$str))
    {
    return true;
  }
  else
    {
    return false;
  }
}
   
?> 